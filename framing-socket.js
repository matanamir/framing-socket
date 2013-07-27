/**
 * TODO: consider refactoring this into a proper Stream
 *
 * Contains the details of the socket connection and any lifecycle code around
 * that socket connection.  It also takes care of framing and associating
 * response data with the proper request.  Note that his FramingSocket
 * assumes that each frame response contains an RPC ID to associate it with
 * the sent request.
 *
 * The user may (and should) provide to the constructor of each instance two custom
 * functions:
 *
 *  - A frame length detection function which would be used to find and parse the
 *    frame length (delegated to the internal FramingBuffer).
 *  - A "RPC ID" detection function which would be used to detect the RPC ID in
 *    the response.
 *
 *
 * Methods:
 *  - connect(host, port):
 *      Creates a new socket and returns a promise.
 *  - close():
 *      Closes an existing socket and returns a promise.
 *  - write(rpc_id, data):
 *      Write data to the socket and returns a promise for the response data.
 *      The RPC ID is used to match the request and response together.
 *  - fail_pending_rpcs():
 *      Fails (rejects) all pending RPCs and calls the errbacks of all queued
 *      promises.
 *
 *
 * Events published:
 *
 *  - disconnected(host, port, last_err):
 *      When the connection has an unplanned disconnection. It includes the
 *      last detected error object.  It is not emitted when close() is called.
 *  - timeout(host, port):
 *      When the socket times out.  The user can decide to what to do after this.
 *  - pause(host, port):
 *      Sent when it wants the user to pause upstream events including the
 *      server's host/port
 *  - resume(host, port):
 *      Sent when the user can continue - including the server's host/port for
 *      reference
 */
module.exports = function(FramingBuffer,
                          OffsetBuffer,
                          debug,
                          net,
                          events,
                          util,
                          when,
                          errors,
                          logger) {

    /**
     * Delay between the last packet and the first keep alive probe in milliseconds
     */
    var keep_alive_delay = 1000;

    /**
     * Ctor. The user should provide the following options (defaults shown):
     * {
     *      timeout_ms: 5000,
     *      warn_buffer_bytes: 524288,
     *      max_buffer_bytes: 1048576,
     *      frame_length_size: 4,
     *      frame_length_writer: function(offset_buffer, frame_length) {
     *          offset_buffer.writeInt32BE(frame_length);
     *      },
     *      frame_length_reader: function(offset_buffer) {
     *          return offset_buffer.readInt32BE();
     *      },
     *      rpc_id_size: 4,
     *      rpc_id_reader: function(offset_buffer) {
     *          return offset_buffer.readInt32BE();
     *      },
     *      rpc_id_writer: function(offset_buffer, rpc_id) {
     *          offset_buffer.writeInt32BE(rpc_id);
     *      }
     * }
     */
    function FramingSocket(options) {

        options = options || {};

        /**
         * A name to give this FramingSocket for logging purposes.
         * This is set to the <host>:<port> when the socket connects
         * to a host and stays that way until it the socket is closed.
         */
        this.name = 'disconnected';

        /**
         * The raw socket used to communicate with the server.
         * This is set in the connect() method and nulled out
         * on an effective close.
         */
        this.socket = null;

        /**
         * To avoid doing cleanup work more than once
         */
        this.closed = false;

        /**
         * Indicates this FramingSocket is waiting for a drain event
         * from the underlying socket.  This is important so we
         * continue to register for 'drain' events in the case
         * where the user does not slow down and allow the 'drain'
         * to happen before sending more write()s.
         */
        this.waiting_for_drain = false;

        /**
         * Holds the last socket error for debugging.  It is set when
         * an error event is received.  This, together with the
         * had_error flag of 'close' can be used to report errors
         * upsteam on disconnections.
         */
        this.last_socket_error = null;

        /**
         * Deferreds that are still pending a response are stored here.  This
         * allows us to cross reference a RPC result to a pending deferred
         * and resolve the promise.
         */
        this.pending_deferreds = {};

        /**
         * Internal framing buffer that deals with framing the incoming
         * data into proper frames
         */
        this.framing_buffer = null;

        /**
         * Keep a reference to the passed in options so we can relay
         * them to the FrameBuffer
         */
        this.options = options;

        /**
         * The client side connection timeout (ms).  If this is reached, the client
         * will end the connection.
         */
        this.timeout_ms = options.timeout_ms || 5000;


        /**
         * A watermark after which the FramingSocket will emit a 'pause' event and
         * will follow with a 'resume' event as soon as the underlying socket is
         * drained.  This is a safety measure for back pressure and gives the user
         * time to slow down writes if needed.  This does not reject the writes
         * though.  However, if max_buffer_bytes is reached, the FramingSocket
         * will start to reject writes.
         */
        this.warn_buffer_bytes = options.warn_buffer_bytes || 524288;

        /**
         * The maximum about of memory to use to buffer writes in the case that
         * the socket write could not complete immediately (due to back pressure
         * or similar).  After this amount of memory is used, the socket
         * reject addition writes by invoking the errback of the returned
         * promise.
         */
        this.max_buffer_bytes = options.max_buffer_bytes || 1048576;

        /**
         * The writer used to write the frame length into bytes.  It is passed an
         * OffsetBuffer and the frame_length to write.
         */
        this.frame_length_writer = options.frame_length_writer || frame_length_writer;

        /**
         * The length of the rpc_id field to use in bytes
         */
        this.rpc_id_size = options.rpc_id_size || 4;

        /**
         * The reader used to read the rpc_id from the buffer.  It is passed
         * in an OffsetBuffer.  The read offset is after the frame_length
         * already.
         */
        this.rpc_id_reader = options.rpc_id_reader || rpc_id_reader;

        /**
         * The reader used to write the rpc_id to the buffer.  It is passed
         * in an OffsetBuffer and the rpc_id to write.
         */
        this.rpc_id_writer = options.rpc_id_writer || rpc_id_writer;

        events.EventEmitter.call(this);
    }
    util.inherits(FramingSocket, events.EventEmitter);

    /**
     * Establishes a socket connection to the provided host and port.
     * Returns a promise that is resolved when the connection state is
     * finalized (failure or success).
     */
    FramingSocket.prototype.connect = function(host, port) {
        var self = this,
            deferred = when.defer();

        if (this.socket) {
            deferred.reject(new errors.AlreadyConnectedError('Already connected to: ' + this.name));
        }
        this.name = host + ':' + port;
        this.closed = false;
        this.last_socket_error = null;
        // create a new FramingBuffer on each connect
        this.framing_buffer = new FramingBuffer(this.options);
        this.socket = net.connect({
            host: host,
            port: port
        }, function on_connect() {
            self.on_socket_connect();
            deferred.resolve();
        });
        this.register_socket_events(deferred);
        return deferred.promise;
    };

    /**
     * Closes any active connection.  The user should not expect a 'disconnected'
     * event when calling this. This returns a promise, but resolves immediately
     * since the clean up steps are synchronous.
     */
    FramingSocket.prototype.close = function() {
        var deferred = when.defer();

        this.clean_up_socket();
        deferred.resolve();
        return deferred.promise;
    };

    /**
     * Writes bytes to the open socket. It returns a promise which is resolved when
     * the return data is available for this (we're assuming a request/response protocol).
     * This involved framing the results properly and matching the proper frame by the RPC ID.
     */
    FramingSocket.prototype.write = function(rpc_id, data) {
        var self = this,
            deferred = when.defer(),
            rpc_key = create_rpc_key(rpc_id),
            socket = this.socket;

        if (!socket) {
            deferred.reject(new errors.NotConnectedError('FramingSocket.write - No socket available yet'));
            return deferred.promise;
        }

        if (this.pending_deferreds[rpc_key]) {
            deferred.reject(new errors.DuplicateDataError('FramingSocket.write - Duplicate RPC: ' + rpc_key + ' written while the previous is still pending.'));
            return deferred.promise;
        }

        // we've overflowed past max_buffer_bytes, so reject the write.
        if (socket.bufferSize > this.max_buffer_bytes) {
            deferred.reject(new errors.BufferOverflowError('FramingSocket.write - max_buffer_size reached.  No new writes are being accepted at the moment.'));
            return deferred.promise;
        }

        // For sockets, the write might not always be immediate.
        // So we have to check the socket's bufferSize to avoid eating up too much memory
        // in the case that the write was added to socket's internal write queue.
        this.write_frame(socket, rpc_id, data);

        if (socket.bufferSize > this.warn_buffer_bytes) {
            // prevent multiple registers of the 'drain' event in the case that the user
            // does not slow down.
            if (!this.waiting_for_drain) {
                this.waiting_for_drain = true;
                socket.once('drain', function on_drain() {
                    self.on_socket_drain();
                });
                process.nextTick(function emit_pause() {
                    self.emit('pause', socket.remoteAddress, socket.remotePort);
                });
            }
        }

        // Keep track of the deferred by the rpc_key so we can find it again when we parse returned frames.
        // We could possible keep track of "expired" RPCs if we find deferreds get orphaned w/o a matching
        // return frame.
        this.pending_deferreds[rpc_key] = {
            timestamp: process.hrtime(),
            deferred: deferred
        };
        return deferred.promise;
    };

    FramingSocket.prototype.on_socket_connect = function() {
        // first since we connected, set the error event handler to exclude the connecting deferred
        this.socket.removeAllListeners('error');
        this.socket.on('error', function on_socket_error(err) {
            self.on_socket_error(err);
        });
        this.socket.setKeepAlive(true, keep_alive_delay);
        this.socket.setNoDelay(true);
        this.socket.setTimeout(this.timeout_ms);
        if (debug) {
            logger.log('FramingSocket.connect - Successfully connected to: ' + this.name);
        }
    };

    /**
     * Deal with situations where the connection times out.  We leave the exact reaction
     * up to the user.  They may decide to close() everything down and start again or
     * something else.
     */
    FramingSocket.prototype.on_socket_timeout = function() {
        if (debug) {
            logger.log('FramingSocket.on_socket_timeout - ' + this.name + ' timed out (' + this.timeout_ms + 'ms).  ');
        }
        this.emit('timeout', this.socket.remoteAddress, this.socket.remotePort);
    };

    /**
     * Note that on_socket_close will always be called after this.
     */
    FramingSocket.prototype.on_socket_error = function(err) {
        this.last_socket_error = err;
        if (debug) {
            logger.log('FramingSocket - Socket: ' + this.name + ' threw an error: ' + util.inspect(err));
        }
    };

    /**
     * Receives close events from the socket.  If the socket was previously known to be
     * open, this is an unexpected disconnection and an 'disconnected' event is fired
     * to anyone who is interested in knowing about unplanned disconnections.
     * Note that it cleans up the socket before emitting the event.
     */
    FramingSocket.prototype.on_socket_close = function(had_error) {
        var host, port;

        if (!this.closed) {
            host = this.socket.remoteAddress;
            port = this.socket.remotePort;
            this.clean_up_socket();
            this.emit('disconnected', host, port, (had_error) ? this.last_socket_error : null);
        }
    };

    FramingSocket.prototype.on_socket_drain = function() {
        this.waiting_for_drain = false;
        this.emit('resume', this.socket.remoteAddress, this.socket.remotePort);
    };

    /**
     *  This is called when we want to proactively fail all the in flight rpcs that are awaiting
     *  responses from the server.  Users might want to call this if some situation arises
     *  and they want to fail queued RPCs.
     */
    FramingSocket.prototype.fail_pending_rpcs = function() {
        var self = this,
            err = new errors.NonRecoverableError('FramingSocket.fail_pending_rpcs called. Possibly due to some' +
            'nasty issue');

        Object.keys(this.pending_deferreds).forEach(function(rpc) {
            self.pending_deferreds[rpc].deferred.reject(err);
        });
        this.pending_deferreds = {}; // clear it up
    };

    /**
     * When a full frame comes in via the FrameBuffer, extract the RPC ID
     * and cross reference it with our pending deferreds so the proper
     * promise can be resolved.
     */
    FramingSocket.prototype.on_frame = function(full_frame) {
        var rpc_id = this.rpc_id_reader(full_frame);
        this.resolve_deferred(rpc_id, full_frame);
    };

    /**
     * Finds the pending deferred for the provided rpc_id and resolves it
     * with the full frame data we have collected.
     */
    FramingSocket.prototype.resolve_deferred = function(rpc_id, frame) {
        var rpc_key = create_rpc_key(rpc_id),
            pending_deferred = this.pending_deferreds[rpc_key],
            diff_hrtime;

        if (!pending_deferred) {
            // Hmm, not much we can really do here other than fail.
            // Note that this type of error will cause the connection to be closed and restarted.
            // All other pending rpcs will fail.
            throw new errors.NonRecoverableError('Couldn\'t find rpc_id: ' + rpc_key + ' in pending queue.');
        }

        if (debug) {
            diff_hrtime = process.hrtime(pending_deferred.timestamp);
            logger.log('Received frame for rpc: ' + rpc_key + ' with size: ' + frame.buf.length +
                '.  Took: ' + ((diff_hrtime[0] * 1e9) + diff_hrtime[1]) + 'ns');
        }

        // remove this pending deferred from the list
        delete this.pending_deferreds[rpc_key];
        pending_deferred.deferred.resolve(frame);
    };

    /**
     * On a FIN packet from the server, we do this.  We'll do a proper
     * tear-down of the socket.
     */
    FramingSocket.prototype.on_socket_end = function() {
        this.on_socket_close(false);
    };

    /**
     * We won't clear the FramingBuffer data here intentionally since maybe the user wants to
     * analyze what's in it.  We do, however, clobber it with a new instance if the user
     * tries to connection again.
     */
    FramingSocket.prototype.clean_up_socket = function() {
        if (!this.closed) {
            this.closed = true;
            this.remove_socket_events();
            // Since we're sending a FIN and removed event listeners, any in flight
            // data events will be lost
            // TODO: figure out if this is a "good thing" :)
            // Another option is to explicitly call this.fail_pending_deferreds()
            // if that is the behavior we want.
            this.pending_deferreds = {}; // clear it up
            this.socket.end();
            this.socket = null;
            if (debug) {
                logger.log('FramingSocket - Socket: ' + this.name + ' closed successfully');
            }
            this.name = 'disconnected';
        } else {
            if (debug) {
                logger.log('FramingSocket - Socket already closed');
            }
        }
    };

    /**
     * Wires up all the socket events.
     */
    FramingSocket.prototype.register_socket_events = function(connecting_deferred) {
        var self = this;

        this.framing_buffer.on('frame', function on_frame(frame) {
            self.on_frame(frame);
        });
        this.socket.on('error', function on_socket_error(err) {
            // if we have a connecting deferred that needs notification,
            // reject it on connection errors
            if (connecting_deferred) {
                connecting_deferred.reject(new errors.HostUnavailableError('Unable to connect to: ' + self.name));
            }
            self.on_socket_error(err);
        });
        this.socket.on('close', function on_socket_close(had_error) {
            self.on_socket_close(had_error);
        });
        this.socket.on('data', function on_socket_data(data) {
            self.framing_buffer.push(data);
        });
        this.socket.on('end', function on_socket_end() {
            self.on_socket_end();
        });
        this.socket.once('timeout', function on_socket_timeout() {
            self.on_socket_timeout();
        });
    };

    /**
     * Removes listeners to all the socket events for convenience
     */
    FramingSocket.prototype.remove_socket_events = function() {
        this.framing_buffer.removeAllListeners('frame');
        this.socket.removeAllListeners('error');
        this.socket.removeAllListeners('close');
        this.socket.removeAllListeners('data');
        this.socket.removeAllListeners('end');
        this.socket.removeAllListeners('timeout'); // this is set to "once"
        this.socket.removeAllListeners('drain'); // this is set to "once"
    };

    /**
     * Writes the data provided to the client to the socket in the proper
     * frame format.
     *
     * At this point, it seems that multiple small rights is slower than
     * creating a new Buffer and copying all the data to it.  This depends
     * on the underlying Node.js behavior around socket write buffering.  The
     * answer will be in libuv.
     *
     * This function returns a true/false value based on the need to deal with
     * back pressure (the same way socket.write()) works.
     */
    FramingSocket.prototype.write_frame = function(socket, rpc_id, data) {
        var frame_length_size = this.framing_buffer.frame_length_size,
            rpc_id_size = this.rpc_id_size,
            frame = new OffsetBuffer(rpc_id_size + frame_length_size + data.length);

        this.frame_length_writer(frame, data.length + rpc_id_size);
        this.rpc_id_writer(frame, rpc_id);
        frame.copyFrom(data);
        return socket.write(frame.buf);
    };

    // Default readers / writers
    function rpc_id_reader(offset_buffer) {
        return offset_buffer.readInt32BE();
    }

    function rpc_id_writer(offset_buffer, rpc_id) {
        offset_buffer.writeInt32BE(rpc_id);
    }

    function frame_length_writer(offset_buffer, frame_length) {
        offset_buffer.writeInt32BE(frame_length);
    }

    function create_rpc_key(rpc_id) {
        return 'rpc_' + rpc_id;
    }

    return FramingSocket;
};