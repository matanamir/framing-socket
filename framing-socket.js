/**
 * TODO: consider refactoring this into a proper Stream
 *
 * Contains the details of the socket connection and any lifecycle code around
 * that socket connection.  It also takes care of framing and associating
 * response data with the proper request.  Note that this FramingSocket assumes
 * a request/response protocol of some form where the first frame bytes are the
 * frame size, and each frame response contains an RPC ID to associate it with
 * the sent request.
 *
 * The user may (and should) provide to the constructor of each instance two custom
 * functions:
 *
 *  - A frame length detection function which would be used to find and parse the
 *    frame length.
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
module.exports = function(OffsetBuffer,
                          BufferGroup,
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
         * The length of the frame_length field in bytes.
         */
        this.frame_length_size = (options && options.frame_length_size) || 4;

        /**
         * The reader used to read the frame_length from the buffer.  It is
         * passed in an OffsetBuffer to read from.
         */
        this.frame_length_reader = (options && options.frame_length_reader) ||
            frame_length_reader;

        /**
         * The reader used to read the rpc_id from the buffer.  It is passed
         * in an OffsetBuffer.  The read offset is after the frame_length
         * already.
         */
        this.rpc_id_reader = (options && options.rpc_id_reader) ||
            rpc_id_reader;

        /**
         * Keeps track of the expected length of the currently processed
         * result frame.  We also use this as our FSM flag:
         *
         *   >0: we assume any data that arrives is part of the
         *       current_frame_buffer.
         *
         *    0: we assume that new data that arrives is the start of a
         *       new frame.
         */
        this.current_frame_length = 0;

        /**
         * Buffer of the current response data.  We'll need to do
         * our own framing of the stream to understand when one response
         * ends, and another begins. We'll buffer a response until a frame
         * ends before resolving the promise from the write().
         */
        this.current_frame_buffer = new BufferGroup();

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
     * We'll need a simple FSM here to buffer data and frame the data properly.
     */
    FramingSocket.prototype.on_socket_data = function(data_buffer) {
        var self = this,
            frame_length = this.current_frame_length,
            frame_buffer = this.current_frame_buffer;

        function check_and_extract_frame() {
            var rpc_id,
                full_frame;
            if (frame_buffer.length >= frame_length) {
                // we're in business!  We've got at least the data we need
                // for a frame (any maybe more). Our BufferGroup will take
                // care of the details of extracting just the bytes we need
                // for this frame and keep the rest intact.
                full_frame = frame_buffer.extract(frame_length);
                // now we reset the frame state and call the relevant deferred...
                frame_length = self.current_frame_length = 0;
                rpc_id = self.rpc_id_reader(full_frame);
                self.resolve_deferred(rpc_id, full_frame);
            }
        }

        //  First, buffer the data
        //  If current_frame_length === 0 we're expecting a new frame...
        //      If have enough data in the buffer to get the frame size?
        //          Extract it from the buffer so it only contains
        //          the frame data.  If the data also includes the
        //          whole frame, we can go ahead and emit
        //          the result, then reset the current_frame_length
        //          instead of waiting for another data event.
        //      If there isn't enough data for the key, keep buffering
        //  If current_frame_length > 0 we're in the middle of a frame...
        //      If we have enough data to parse the frame?
        //          Do it, reset the state (current_frame_length,
        //          current_frame_buffer).  If there is any data left
        //          over, start at the top...
        frame_buffer.push(data_buffer);
        if (frame_length  === 0) {
            if (frame_buffer.length >= this.frame_length_size) {
                // TODO: there are some performance improvements we can make here on the occasion
                // TODO: that the full frame length and full frame data is passed in at once.
                frame_length = this.current_frame_length =
                    this.frame_length_reader(frame_buffer.extract(this.frame_length_size));
                check_and_extract_frame();
            }
        } else {
            check_and_extract_frame();
        }
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

        this.socket.on('error', function on_socket_error() {
            self.on_socket_error();
        });
        this.socket.on('close', function on_socket_close(had_error) {
            self.on_socket_close(had_error);
        });
        this.socket.on('data', function on_socket_data(data) {
            self.on_socket_data(data);
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
        this.socket.removeAllListeners('error');
        this.socket.removeAllListeners('close');
        this.socket.removeAllListeners('data');
        this.socket.removeAllListeners('end');
        this.socket.removeAllListeners('timeout'); // this is set to "once"
        this.socket.removeAllListeners('drain'); // this is set to "once"
    };

    // Default frame_length_reader
    function frame_length_reader(offset_buffer) {
        return offset_buffer.readInt32BE();
    }

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