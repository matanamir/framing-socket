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
                          debug,
                          net,
                          events,
                          util,
                          when,
                          errors,
                          logger) {

    /**
     * The timeout delay in milliseconds
     */
    var timeout = 5000;

    /**
     * Delay between the last packet and the first keep alive probe in milliseconds
     */
    var keep_alive_delay = 1000;

    /**
     * The maximum number of false writes to accumulate before we start asking the user
     * to throttle their writes.
     */
    var max_false_writes = 5;

    /**
     * Ctor. The user should provide the following options (defaults shown):
     * {
     *      frame_length_size: 4;
     *      frame_length_reader: function(offset_buffer) {
     *          return offset_buffer.readInt32BE();
     *      },
     *      rpc_id_reader: function(offset_buffer) {
     *          return offset_buffer.readInt32BE();
     *      }
     * }
     */
    function FramingSocket(options) {

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
         * Holds the last socket error for debugging.  It is set when
         * an error event is received.  This, together with the
         * had_error flag of 'close' can be used to report errors
         * upsteam on disconnections.
         */
        this.last_socket_error = null;

        /**
         * A simple way of keeping node's internal buffering of write data
         * under control.  If we exceed the max_false_writes number on
         * consecutive writes (without a drain event in between), we will
         * emit a 'pause' event so hopefully upstream something will throttle
         * their writes.  A 'resume' event is sent upstream as soon as a
         * 'drain' event is received from the socket.
         */
        this.num_false_writes = 0;

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
         * Keep a reference to the passed in options
         */
        this.options = options;

        /**
         * The reader used to read the rpc_id from the buffer.  It is passed
         * in an OffsetBuffer.  The read offset is after the frame_length
         * already.
         */
        this.rpc_id_reader = (options && options.rpc_id_reader) ||
            rpc_id_reader;

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
            deferred.reject(new errors.AlreadyConnectedError('Already connected to: ' + socket_host_port(this.socket)));
        }
        this.closed = false;
        this.last_socket_error = null;
        this.num_false_writes = 0;
        // create a new FramingBuffer on each connect
        this.framing_buffer = new FramingBuffer(this.options);
        this.socket = net.connect({
            host: host,
            port: port
        }, function on_connect() {
            self.on_socket_connect();
            deferred.resolve();
        });
        self.register_socket_events();
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
            rpc_key = create_rpc_key(rpc_id);

        if (!this.socket) {
            deferred.reject(new errors.NotConnectedError('FramingSocket.write - No socket available yet'));
            return deferred.promise;
        }

        if (this.pending_deferreds[rpc_key]) {
            deferred.reject(new errors.DuplicateDataError('FramingSocket.write - Duplicate RPC: ' + rpc_key + ' written while the previous is still pending.'));
            return deferred.promise;
        }

        // I assume this will emit an 'error' event if the socket is closed
        if (!this.socket.write(data)) {
            this.num_false_writes++;
            this.socket.once('drain', function() {
                self.on_socket_drain();
            });
            // If we've past the maximum number of consecutive false writes, let's ask the user
            // to pause their writing.
            if (this.num_false_writes > max_false_writes) {
                this.emit('pause', this.socket.remoteAddress, this.socket.remotePort);
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
        this.socket.setKeepAlive(true, keep_alive_delay);
        this.socket.setNoDelay(true);
        this.socket.setTimeout(timeout);
        logger.info('FramingSocket.connect - Successfully connected to: ' + socket_host_port(this.socket));
    };

    /**
     * Deal with situations where the connection times out.  We leave the exact reaction
     * up to the user.  They may decide to close() everything down and start again or
     * something else.
     */
    FramingSocket.prototype.on_socket_timeout = function() {
        logger.info('FramingSocket.on_socket_timeout - ' + socket_host_port(this.socket) + ' timed out (' + timeout + 'ms).  ');
        this.emit('timeout', this.socket.remoteAddress, this.socket.remotePort);
    };

    /**
     * Note that on_socket_close will always be called after this.
     */
    FramingSocket.prototype.on_socket_error = function(err) {
        this.last_socket_error = err;
        logger.info('FramingSocket - Socket: ' + socket_host_port(this.socket) + ' threw an error: ' + util.inspect(err));
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
        this.num_false_writes = 0;
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
            logger.info('Received frame for rpc: ' + rpc_key + ' with size: ' + frame.length +
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
            this.socket.end();
            this.socket = null;
            logger.info('FramingSocket - Socket: ' + socket_host_port(this.socket) + ' closed successfully');
        } else {
            if (debug) {
                logger.info('FramingSocket - Socket: ' + socket_host_port(this.socket) + ' already closed');
            }
        }
    };

    /**
     * Wires up all the socket events.
     */
    FramingSocket.prototype.register_socket_events = function() {
        var self = this;

        this.framing_buffer.on('frame', function on_frame(frame) {
            self.on_frame(frame);
        });
        this.socket.on('error', function on_socket_error() {
            self.on_socket_error();
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

    // Default rpc_id_reader
    function rpc_id_reader(offset_buffer) {
        return offset_buffer.readInt32BE();
    }

    function create_rpc_key(rpc_id) {
        return 'rpc_' + rpc_id;
    }

    function socket_host_port(socket) {
        if (socket) {
            return socket.remoteAddress + ':' + socket.remotePort;
        } else {
            return 'undefined';
        }
    }

    return FramingSocket;
};