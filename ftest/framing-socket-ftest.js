var test = require('tap').test,
    TestSocketServer = require('test-socket-server'),
    FramingSocket = require('../index.js'),
    when = require('when'),
    util = require('util'),
    host = 'localhost',
    port = 8111;

// -----------------------------------------------------
// Test Socket Server Functional Tests
// -----------------------------------------------------

test('Client connect -> server down', function(t) {
    var client = create_client();

    client.connect(host, port).otherwise(function() {
        t.ok(true, 'Client called errback on failure to connect');
        t.end();
    });
});

test('Client connect -> client disconnect x 10', function(t) {
    var client = create_client(),
        server = create_server(),
        deferred = when.defer();

    server.listen(port).then(function() {
        (function next(iteration) {
            if (iteration >= 10) {
                t.ok(true, 'Client can perform multiple connect/disconnect cycles');
                t.ok((client.socket === null), 'Client socket is nulled');
                t.equal(Object.keys(client.pending_deferreds).length, 0, 'No pending deferreds for this client');
                t.end();
                deferred.resolve();
                return;
            }
            client.connect(host, port).then(function() {
                return client.close();
            }).then(function() {
                next(iteration + 1);
            }).otherwise(function() {
                t.ok(false, 'Client fails to support multiple connect/disconnect cycles');
                t.end();
            });
        })(0);

        deferred.promise.then(function() {
            return server.close();
        }).then(function () {
            t.end();
        });
    });
});

test('Client connect -> client write full frame -> client disconnect', function(t) {
    var server = create_server(),
        client = create_client(),
        rpc_id = 1;

    server.listen(port).then(function() {
        return client.connect(host, port);
    }).then(function() {
        client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]));
        // let's not wait for the server to return a result...
        return client.close();
    }).then(function() {
        return server.close();
    }).then(function() {
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_deferreds).length, 0, 'No pending deferreds for this client');
        t.end();
    }).otherwise(function(err) {
        t.ok(false, 'Error caught: ' + util.inspect(err));
        t.end();
        return server.close();
    });
});

test('Client connect -> client write full frame -> server disconnect', function(t) {
    var server = create_server(),
        client = create_client(),
        rpc_id = 1;

    function on_disconnected() {
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_deferreds).length, 0, 'No pending deferreds for this client');
        t.end();
    }

    server.listen(port).then(function() {
        client.on('disconnected', on_disconnected);
        return client.connect(host, port);
    }).then(function() {
        client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]));
        // let's not wait for the server to return a result...
        return server.close();
    }).otherwise(function(err) {
        t.ok(false, 'Error caught: ' + util.inspect(err));
        t.end();
        return server.close();
    });
});

test('Client connect -> client write full frame -> server stuck -> client timeout', function(t) {
    var server = create_server({
            stuck_before_response: true
        }),
        client = create_client({
            timeout_ms: 1000
        }),
        rpc_id = 1;

    function on_timeout() {
        client.close().then(function() {
            return server.close();
        }).then(function() {
            t.end();
        });
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_deferreds).length, 0, 'No pending deferreds for this client');
        t.end();
    }

    client.on('timeout', on_timeout);

    server.listen(port).then(function() {
        return client.connect(host, port);
    }).then(function() {
        return client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]));
    }).then(function() {
        t.ok(false, 'Result should not have made it back to client before timeout');
    }).otherwise(function(err) {
        t.ok(false, 'Error caught: ' + util.inspect(err));
        t.end();
        return server.close();
    });
});

test('Client connect -> client write full frame -> server response partial frame -> server stuck -> client timeout', function(t) {
    var server = create_server({
            stuck_partial_response: true
        }),
        client = create_client({
            timeout_ms: 1000
        }),
        rpc_id = 1;

    function on_timeout() {
        client.close().then(function() {
            return server.close();
        }).then(function() {
                t.end();
            });
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_deferreds).length, 0, 'No pending deferreds for this client');
        t.end();
    }

    client.on('timeout', on_timeout);

    server.listen(port).then(function() {
        return client.connect(host, port);
    }).then(function() {
        return client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]));
    }).then(function() {
        t.ok(false, 'Result should not have made it back to client before timeout');
    }).otherwise(function(err) {
        t.ok(false, 'Error caught: ' + util.inspect(err));
        t.end();
        return server.close();
    });
});

test('Client connect -> client write full frame -> server response partial frame -> server disconnect', function(t) {
    var server = create_server({
            stuck_partial_response: true,
            stuck_action: on_stuck
        }),
        client = create_client(),
        rpc_id = 1;

    function on_stuck(connection) {
        return this.close();
    }

    function on_disconnected() {
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_deferreds).length, 0, 'No pending deferreds for this client');
        t.end();
    }

    client.on('disconnected', on_disconnected);

    server.listen(port).then(function() {
        return client.connect(host, port);
    }).then(function() {
        return client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]));
    }).then(function() {
        t.ok(false, 'Result should not have made it back to client before timeout');
    }).otherwise(function(err) {
        t.ok(false, 'Error caught: ' + util.inspect(err));
        t.end();
        return server.close();
    });
});

test('Client connect -> client write full frame -> server response partial frame -> server timeout', function(t) {
    var server = create_server({
            timeout_ms: 1000,       // faster than the stuck_ms
            stuck_partial_response: true
        }),
        client = create_client(),
        rpc_id = 1;

    function on_disconnected() {
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_deferreds).length, 0, 'No pending deferreds for this client');
        t.end();
        return server.close();
    }

    client.on('disconnected', on_disconnected);

    server.listen(port).then(function() {
        return client.connect(host, port);
    }).then(function() {
        return client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]));
    }).then(function() {
        t.ok(false, 'Result should not have made it back to client before timeout');
    }).otherwise(function(err) {
        t.ok(false, 'Error caught: ' + util.inspect(err));
        t.end();
        return server.close();
    });
});

test('Client connect -> (client write full frame -> server response full frame) x 10 -> client disconnect', function(t) {
    var client = create_client(),
        server = create_server(),
        deferred = when.defer(),
        rpc_id = 1,
        buf = new Buffer([0x01, 0x02, 0x03]);

    server.listen(port).then(function() {
        client.connect(host, port).then(function() {
            (function next(iteration) {
                if (iteration >= 10) {
                    t.ok(true, 'Client can perform multiple write/receive cycles');
                    t.end();
                    deferred.resolve();
                    return;
                }
                client.write(rpc_id, buf).then(function() {
                    next(iteration + 1);
                }).otherwise(function() {
                    t.ok(false, 'Client fails to support multiple write/receive cycles');
                    t.end();
                });
            })(0);
        });

        deferred.promise.then(function() {
            return client.close();
        }).then(function() {
            return server.close();
        }).then(function () {
            t.end();
        });
    });
});

function create_client(options) {
    return new FramingSocket(options);
}

function create_server(options) {
    return new TestSocketServer(options);
}






