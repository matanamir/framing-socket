var test = require('tap').test,
    util = require('util'),
    sinon = require('sinon'),
    net = create_mock_net(),
    events = require('events'),
    debug = true,
    errors = require('../errors.js')(util),
    FramingBuffer = require('framing-buffer'),
    OffsetBuffer = require('offset-buffer'),
    FramingSocket = require('../framing-socket.js')(
        FramingBuffer,
        OffsetBuffer,
        debug,
        net,
        events,
        util,
        errors,
        console
    );

process.on('uncaughtException', function(err) {
    console.log('Uncaught exception: ' + err);
    process.exit(-1);
});

test('connect()', function(t) {
    t.test('Returns a promise which resolves on a successful connection', function(t) {
        var con = new FramingSocket();

        function on_connect(err) {
            if (err) {
                errback(t, err);
            }
            t.ok(true, 'Promise resolves once the connection is complete.');
            t.ok((con.socket !== null), 'Socket is active');
            t.end();
        }

        con.connect('localhost', 8888, on_connect);
    });
    t.test('Fails if a connection already exists', function(t) {
        var con = new FramingSocket();

        function on_connect1(err) {
            if (err) {
                errback(t, err);
                return;
            }
            con.connect('localhost', 8888, on_connect2);
        }

        function on_connect2(err) {
            if (err) {
                t.ok(true, 'Promise resolves once the connection is complete.');
                t.ok((con.socket !== null), 'Socket is active');
                t.end();
            } else {
                t.ok(false, 'Second connection should not succeed!');
            }
        }

        con.connect('localhost', 8888, on_connect1);
    });
    t.end();
});

test('close()', function(t) {
    after_connection(t, function on_connect(con) {
        sinon.spy(con, "clean_up_socket");
        t.ok(!con.closed, 'Before close(), connection is open');
        t.ok(!con.clean_up_socket.calledOnce, 'Before close(), clean_up_socket() was not called.');
        con.close();
        t.ok(con.clean_up_socket.calledOnce, 'Calls clean_up_socket() internally');
        t.end();
    });
});

test('on_socket_timeout()', function(t) {
    after_connection(t, function on_connect(con) {
        con.on('timeout', function() {
            t.ok(true, 'FramingSocket emits a timeout event when the socket times out.');
            t.end();
        });
        con.socket.emit('timeout');
    });
});

test('clean_up_socket()', function(t) {
    after_connection(t, function on_connect(con) {
        test_socket_cleanup(con, t, function() {
            con.clean_up_socket();
        });
        t.end();
    });
});

test('on_socket_end()', function(t) {
    after_connection(t, function(con) {
        test_socket_cleanup(con, t, function() {
            con.socket.emit('end');
        });
        t.end();
    });
});

test('write()', function(t) {
    var buf = new Buffer([0x01, 0x02, 0x03]);
    t.test('Write fails if socket is closed', function(t) {
        var con = new FramingSocket();
        con.write(1, buf, function on_frame(err) {
            if (err) {
                t.ok(true, 'Errback is called successfully when the socket is closed');
                t.ok((err instanceof errors.NotConnectedError), 'Error is of type NotConnectedError');
                t.end();
            } else {
                t.ok(false, 'Socket write should fail if socket is closed');
            }
        });
    });
    t.test('On an open socket...', function(t) {
        t.test('Write succeeds when there are no duplicates', function(t) {
            after_connection(t, function on_connect(con) {
                con.write(1, buf, function on_frame(err) {
                    if (err) {
                        errback(t, err);
                        return;
                    }
                });
                // since we don't actually get a reply, assume success
                t.ok((Object.keys(con.pending_callbacks).length > 0), 'Deferred is saved as pending.');
                t.end();
            });
        });
        t.test('Write fails if they are duplicates', function(t) {
            after_connection(t, function on_connect(con) {
                con.write(1, buf, function on_frame(err) {
                    if (err) {
                        errback(t, err);
                        return;
                    }
                });
                con.write(1, buf, function on_frame(err) {
                    if (err) {
                        t.ok(true, 'Write rejected since the same RPC is pending');
                        t.ok((err instanceof errors.DuplicateDataError), 'Error is of type DuplicateDataError');
                        t.end();
                    } else {
                        t.ok(false, 'Shouldn\'t succeed to write a duplicate RPC');
                    }
                });
            });
        });
        t.test('Write fails if max_buffer_size is passed', function(t) {
            after_connection(t, function on_connect(con) {
                con.socket.bufferSize = con.max_buffer_bytes + 1;
                promise = con.write(1, buf, function on_frame(err) {
                    if (err) {
                        t.ok(true, 'Write rejected since max_buffer_size is passed.');
                        t.ok((err instanceof errors.BufferOverflowError), 'Error is of type BufferOverflowError');
                        t.end();
                    } else {
                        t.ok(false, 'Write should fail due to max_bufer_size');
                    }
                });
            });
        });
        t.end();
    });
    t.end();
});

test('fail_pending_rpcs()', function(t) {
    var buf = new Buffer([0x01, 0x02, 0x03]),
        num_writes = 3;
    t.plan(num_writes * 2);
    function create_errback(n) {
        return function(err) {
            t.ok(true, 'Errback ' + n + ' when fail_pending_rpcs() called');
            t.ok((err instanceof errors.NonRecoverableError), 'Error ' + n + ' is of type NonRecoverableError');
        };
    }
    after_connection(t, function on_connect(con) {
        for (var n = 0; n < num_writes; n++) {
            con.write(n, buf, create_errback(n));
        }
        con.fail_pending_rpcs();
    });
});

test('resolve_callback()', function(t) {
    var response_frame = new OffsetBuffer(new Buffer([0x01, 0x02, 0x03]));
    after_connection(t, function on_connect(con) {
        con.write(1, new Buffer([0x01]), function on_frame(err, full_frame) {
            if (err) {
                errback(t, err);
                return;
            }
            t.ok(true, 'Promise is resolved properly');
            t.ok(buffer_equal(full_frame, response_frame), 'Frame returned is the same as received via socket data');
            t.equal(Object.keys(con.pending_callbacks).length, 0, 'FramingSocket cleaned up pending deferred');
            t.end();
        });
        con.resolve_callback(1, response_frame);
    });
});

test('on_frame()', function(t) {
    var request_buffer = new Buffer([0x01]),
        request_rpc = 1;
    after_connection(t, function on_connect(con) {
        var data_frame, expected;
        data_frame = new Buffer(4 + 4 + 4);
        data_frame.writeInt32BE(8, 0); // length
        data_frame.writeInt32BE(request_rpc, 4); // rpc id
        data_frame.writeInt32BE(100, 8); // some data
        expected = data_frame.slice(4);
        con.write(request_rpc, request_buffer, function on_frame(err, frame) {
            if (err) {
                errback(t, err);
                return;
            }
            t.ok(buffer_equal(frame.buf, expected), 'Returned frame matched expected frame');
            t.end();
        });
        con.socket.emit('data', data_frame);
    });
});

test('on_socket_drain()', function(t) {
    after_connection(t, function on_connect(con) {
        // set up for a pause event
        con.socket.bufferSize = con.warn_buffer_bytes + 1;
        t.plan(2); // plans two tests so it completes successfully automagically
        con.on('pause', function() {
            t.ok(true, 'Emits a \'pause\' event when pressure builds up');
        });
        con.on('resume', function() {
            t.ok(true, 'Emits \'resume\' event when receives \'drain\' event from the socket');
        });
        con.write(1, new Buffer([0x01, 0x02, 0x03]), function on_frame(err, frame) {});
        con.socket.emit('drain');
    });
});

function after_connection(t, fn) {
    var con = new FramingSocket();
    con.connect('localhost', 8888, function on_connect(err) {
        if (err) {
            errback(t, err);
        }
        try {
            fn(con);
        } catch (err) {
            errback(t, err);
        }
    });
}

function test_socket_cleanup(con, t, catalyst) {
    t.ok(!con.closed, 'Before cleanup, connection not closed.');
    t.ok(has_socket_listeners(con.socket), 'Before cleanup, connection has listeners for the underlying socket');
    t.ok(!con.socket.end.calledOnce, 'Before cleanup, socket.end() was not called.');
    catalyst();
    t.ok(con.closed, 'Connection is set to closed after call');
    t.ok(!has_socket_listeners(con.socket), 'All listeners for the underlying socket are removed');
    t.ok(con.socket === null, 'Connection has no more socket');
}

function has_socket_listeners(socket) {
    if (socket === null) {
        return false;
    } else {
        return socket.listeners('error').length ||
            socket.listeners('close').length ||
            socket.listeners('data').length ||
            socket.listeners('end').length ||
            socket.listeners('timeout').length ||
            socket.listeners('drain').length;
    }
}

function errback(t, err) {
    t.ok(false, 'Errback called in test unexpectantly: ' + util.inspect(err));
    t.end();
}

function create_mock_net() {
    return {
        connect: function(options, callback) {
            var socket = new MockSocket(options);
            process.nextTick(callback);
            return socket;
        }
    };
}

function buffer_equal(buffer1, buffer2) {
    return buffer1.toString('hex') === buffer2.toString('hex');
}

function MockSocket(options) {
    this.remoteAddress = options.host;
    this.remotePort = options.port;
    this.setKeepAlive = sinon.spy();
    this.setNoDelay = sinon.spy();
    this.setTimeout = sinon.spy();
    this.end = sinon.spy();
    this.bufferSize = 0;
    this.write = sinon.spy(function(data) {
        return true;
    });
    events.EventEmitter.call(this);
}
util.inherits(MockSocket, events.EventEmitter);
