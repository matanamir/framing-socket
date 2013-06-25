var test = require('tap').test,
    util = require('util'),
    sinon = require('sinon'),
    net = create_mock_net(),
    events = require('events'),
    debug = true,
    when = require('when'),
    errors = require('../errors.js')(util),
    OffsetBuffer = require('offset-buffer'),
    BufferGroup = require('buffer-group'),
    FramingSocket = require('../framing-socket.js')(
        OffsetBuffer,
        BufferGroup,
        debug,
        net,
        events,
        util,
        when,
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
        con.connect('localhost', 8888).then(function() {
            t.ok(true, 'Promise resolves once the connection is complete.');
            t.ok((con.socket !== null), 'Socket is active');
            t.end();
        }, function(err) {
            errback(t, err);
        });
    });
    t.test('Fails if a connection already exists', function(t) {
        var con = new FramingSocket();
        con.connect('localhost', 8888).then(function() {
            con.connect('localhost', 8888).otherwise(function(err) {
                t.ok(true, 'Errback is called when the connection fails');
                t.ok((err instanceof errors.AlreadyConnectedError), 'Errback includes proper AlreadyConnectedError');
                t.end();
            });
        }, function(err) {
            errback(t, err);
        });
    });
    t.end();
});

test('close()', function(t) {
    after_connection(t, function(con) {
        sinon.spy(con, "clean_up_socket");
        t.ok(!con.closed, 'Before close(), connection is open');
        t.ok(!con.clean_up_socket.calledOnce, 'Before close(), clean_up_socket() was not called.');
        con.close().then(function() {
            t.ok(true, 'Close promise resolves properly');
            t.ok(con.clean_up_socket.calledOnce, 'Calls clean_up_socket() internally');
            t.end();
        }, function(err) {
            errback(t, err);
        });
    });
});

test('on_socket_timeout()', function(t) {
    after_connection(t, function(con) {
        con.on('timeout', function() {
            t.ok(true, 'FramingSocket emits a timeout event when the socket times out.');
            t.end();
        });
        con.socket.emit('timeout');
    });
});

test('clean_up_socket()', function(t) {
    after_connection(t, function(con) {
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
        con.write(1, buf).otherwise(function(err) {
            t.ok(true, 'Errback is called successfully when the socket is closed');
            t.ok((err instanceof errors.NotConnectedError), 'Error is of type NotConnectedError');
            t.end();
        });
    });
    t.test('On an open socket...', function(t) {
        t.test('Write succeeds when there are no duplicates', function(t) {
            var promise;
            after_connection(t, function(con) {
                promise = con.write(1, buf);
                t.ok((promise !== null), 'Promise returned successfully and not rejected');
                t.ok((Object.keys(con.pending_deferreds).length > 0), 'Deferred is saved as pending.');
                t.end();
            });
        });
        t.test('Write fails if they are duplicates', function(t) {
            var promise;
            after_connection(t, function(con) {
                con.write(1, buf).otherwise(function() {
                    errback(t);
                });
                promise = con.write(1, buf).otherwise(function(err) {
                    t.ok(true, 'Write rejected since the same RPC is pending');
                    t.ok((err instanceof errors.DuplicateDataError), 'Error is of type DuplicateDataError');
                    t.end();
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
    function create_otherwise(n) {
        return function(err) {
            t.ok(true, 'Rejected promise ' + n + ' when fail_pending_rpcs() called');
            t.ok((err instanceof errors.NonRecoverableError), 'Error ' + n + ' is of type NonRecoverableError');
        };
    }
    after_connection(t, function(con) {
        for (var n = 0; n < num_writes; n++) {
            con.write(n, buf).otherwise(create_otherwise(n));
        }
        con.fail_pending_rpcs();
    });
});

test('resolve_deferred()', function(t) {
    var response_frame = new Buffer([0x01, 0x02, 0x03]);
    after_connection(t, function(con) {
        con.write(1, new Buffer([0x01])).then(function(full_frame) {
            t.ok(true, 'Promise is resolved properly');
            t.ok(buffer_equal(full_frame, response_frame), 'Frame returned is the same as received via socket data');
            t.equal(Object.keys(con.pending_deferreds).length, 0, 'FramingSocket cleaned up pending deferred');
            t.end();
        }).otherwise(function(err) {
            errback(t, err);
        });
        con.resolve_deferred(1, response_frame);
    });
});

test('on_socket_data()', function(t) {
    var request_buffer = new Buffer([0x01]),
        request_rpc = 1;
    t.test('Full key and full data.  Exact size.', function(t) {
        after_connection(t, function(con) {
            var data_frame, expected;
            data_frame = new OffsetBuffer(4 + 4 + 4);
            data_frame.writeInt32BE(8); // length
            data_frame.writeInt32BE(request_rpc); // rpc id
            data_frame.writeInt32BE(100); // some data
            expected = data_frame.buf.slice(4);
            con.write(request_rpc, request_buffer).then(function(frame) {
                t.ok(buffer_equal(frame.buf, expected), 'Returned frame matched expected frame');
                t.end();
            });
            con.socket.emit('data', data_frame.buf);
        });
    });
    t.test('Full key and then data in 2 parts.', function(t) {
        after_connection(t, function(con) {
            var data_frame1,
                data_frame2,
                expected;
            data_frame1 = new OffsetBuffer(4 + 4);
            data_frame1.writeInt32BE(8); // length
            data_frame1.writeInt32BE(request_rpc); // rpc id
            data_frame2 = new OffsetBuffer(4);
            data_frame2.writeInt32BE(100); // some data
            expected = Buffer.concat([data_frame1.buf.slice(4), data_frame2.buf]);
            con.write(request_rpc, request_buffer).then(function(frame) {
                t.ok(buffer_equal(frame.buf, expected), 'Returned frame matched the expected frame');
                t.end();
            });
            con.socket.emit('data', data_frame1.buf);
            con.socket.emit('data', data_frame2.buf);
        });
    });
    t.test('Key in 2 parts where second has full data.', function(t) {
        after_connection(t, function(con) {
            var data_frame1,
                data_frame2,
                expected;
            data_frame1 = new OffsetBuffer(2);
            data_frame1.writeInt16BE(0); // length part 1
            data_frame2 = new OffsetBuffer(10);
            data_frame2.writeInt16BE(8); // length part 2
            data_frame2.writeInt32BE(request_rpc); // rpc id
            data_frame2.writeInt32BE(100); // some data
            expected = data_frame2.buf.slice(2);
            con.write(request_rpc, request_buffer).then(function(frame) {
                t.ok(buffer_equal(frame.buf, expected), 'Returned frame matched the expected frame');
                t.end();
            });
            con.socket.emit('data', data_frame1.buf);
            con.socket.emit('data', data_frame2.buf);
        });
    });
    t.test('Key in 2 parts, and data in 2 parts with some extra past the frame.', function(t) {
        after_connection(t, function(con) {
            var data_frame1,
                data_frame2,
                data_frame3,
                expected;
            data_frame1 = new OffsetBuffer(2);
            data_frame1.writeInt16BE(0); // length part 1
            data_frame2 = new OffsetBuffer(6);
            data_frame2.writeInt16BE(8); // length part 2
            data_frame2.writeInt32BE(request_rpc); // rpc id
            data_frame3 = new OffsetBuffer(8);
            data_frame3.writeInt32BE(100); // some data
            data_frame3.writeInt32BE(200); // some data outside the frame
            expected = Buffer.concat([data_frame2.buf.slice(2), data_frame3.buf.slice(0, 4)]);
            con.write(request_rpc, request_buffer).then(function(frame) {
                t.ok(buffer_equal(frame.buf, expected), 'Returned frame matched the expected frame');
                t.end();
            });
            con.socket.emit('data', data_frame1.buf);
            con.socket.emit('data', data_frame2.buf);
            con.socket.emit('data', data_frame3.buf);
        });
    });
});

test('on_socket_drain()', function(t) {
    after_connection(t, function(con) {
        // set up for a drain event
        con.socket.write = sinon.spy(function(data) {
            return false;
        });
        con.num_false_writes = 5;
        t.plan(2); // plans two tests so it completes successfully automagically
        con.on('pause', function() {
            t.ok(true, 'Emits a \'pause\' event when pressure builds up');
        });
        con.on('resume', function() {
            t.ok(true, 'Emits \'resume\' event when receives \'drain\' event from the socket');
        });
        con.write(new Buffer([0x01, 0x02, 0x03]));
        con.socket.emit('drain');
    });
});

function after_connection(t, fn) {
    var con = new FramingSocket();
    con.connect('localhost', 8888).then(function() {
        fn(con);
    }).otherwise(function(err) {
        errback(t, err);
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
    this.write = sinon.spy(function(data) {
        return true;
    });
    events.EventEmitter.call(this);
}
util.inherits(MockSocket, events.EventEmitter);