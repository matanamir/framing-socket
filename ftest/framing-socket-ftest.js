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

    client.connect(host, port, function on_connect(err) {
        if (err) {
            t.ok(true, 'Client called errback on failure to connect');
            t.end();
        }
    });
});

test('Client connect -> client disconnect x 10', function(t) {
    var client = create_client(),
        server = create_server();

    function on_server_close() {
        t.end();
    }

    function on_done() {
        server.close(on_server_close);
    }

    function on_server_listen() {
        (function next(iteration) {
            if (iteration >= 10) {
                t.ok(true, 'Client can perform multiple connect/disconnect cycles');
                t.ok((client.socket === null), 'Client socket is nulled');
                t.equal(Object.keys(client.pending_callbacks).length, 0, 'No pending callbacks for this client');
                t.end();
                on_done();
                return;
            }
            client.connect(host, port, function on_client_close() {
                client.close();
                next(iteration + 1);
            });
        })(0);
    }

    server.listen(port, on_server_listen);
});

test('Client connect -> client write full frame -> client disconnect', function(t) {
    var server = create_server(),
        client = create_client(),
        rpc_id = 1;

    function on_server_close() {
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_callbacks).length, 0, 'No pending callbacks for this client');
        t.end();
    }

    function on_client_write(err, frame) {
        // no op
    }

    function on_client_connect(err) {
        if (err) {
            errback(t, err, server);
            return;
        }
        client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]), on_client_write);
        client.close();
        server.close(on_server_close);
    }

    function on_server_listen() {
        client.connect(host, port, on_client_connect);
    }

    server.listen(port, on_server_listen);
});

test('Client connect -> client write full frame -> server disconnect', function(t) {
    var server = create_server(),
        client = create_client(),
        rpc_id = 1;

    function on_disconnected() {
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_callbacks).length, 0, 'No pending callbacks for this client');
        t.end();
    }

    function on_server_close() {
        // no op
    }

    function on_client_write(err, frame) {
        // no op
    }

    function on_client_connect(err) {
        if (err) {
            errback(t, err, server);
            return;
        }
        client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]), on_client_write);
        server.close(on_server_close);
    }

    function on_server_listen() {
        client.on('disconnected', on_disconnected);
        client.connect(host, port, on_client_connect);
    }

    server.listen(port, on_server_listen);
});

test('Client connect -> client write full frame -> server stuck -> client timeout', function(t) {
    var server = create_server({
            stuck_before_response: true
        }),
        client = create_client({
            timeout_ms: 1000
        }),
        rpc_id = 1;

    function on_server_close() {
    }

    function on_timeout() {
        client.close();
        server.close(on_server_close);
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_callbacks).length, 0, 'No pending callbacks for this client');
        t.end();
    }

    function on_client_write(err, frame) {
        t.ok(false, 'Result should not have made it back to client before timeout');
    }

    function on_client_connect(err) {
        if (err) {
            errback(t, err, server);
            return;
        }
        client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]), on_client_write);
    }

    function on_server_listen() {
        client.on('timeout', on_timeout);
        client.connect(host, port, on_client_connect);
    }

    server.listen(port, on_server_listen);
});

test('Client connect -> client write full frame -> server response partial frame -> server stuck -> client timeout', function(t) {
    var server = create_server({
            stuck_partial_response: true
        }),
        client = create_client({
            timeout_ms: 1000
        }),
        rpc_id = 1;

    function on_server_close() {
    }

    function on_timeout() {
        client.close();
        server.close(on_server_close);
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_callbacks).length, 0, 'No pending callbacks for this client');
        t.end();
    }

    function on_client_write(err, frame) {
        t.ok(false, 'Result should not have made it back to client before timeout');
    }

    function on_client_connect(err) {
        if (err) {
            errback(t, err, server);
            return;
        }
        client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]), on_client_write);
    }

    function on_server_listen() {
        client.on('timeout', on_timeout);
        client.connect(host, port, on_client_connect);
    }

    server.listen(port, on_server_listen);
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
        t.equal(Object.keys(client.pending_callbacks).length, 0, 'No pending callbacks for this client');
        t.end();
    }

    function on_client_write(err, frame) {
        t.ok(false, 'Result should not have made it back to client before timeout');
    }

    function on_client_connect(err) {
        if (err) {
            errback(t, err, server);
            return;
        }
        client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]), on_client_write);
    }

    function on_server_listen() {
        client.on('disconnected', on_disconnected);
        client.connect(host, port, on_client_connect);
    }

    server.listen(port, on_server_listen);
});

test('Client connect -> client write full frame -> server response partial frame -> server timeout', function(t) {
    var server = create_server({
            timeout_ms: 1000,       // faster than the stuck_ms
            stuck_partial_response: true
        }),
        client = create_client(),
        rpc_id = 1;

    function on_server_close() {
    }

    function on_disconnected() {
        t.ok((client.socket === null), 'Client socket is nulled');
        t.equal(Object.keys(client.pending_callbacks).length, 0, 'No pending callbacks for this client');
        t.end();
        server.close(on_server_close);
    }

    function on_client_write(err, frame) {
        t.ok(false, 'Result should not have made it back to client before timeout');
    }

    function on_client_connect(err) {
        if (err) {
            errback(t, err, server);
            return;
        }
        client.write(rpc_id, new Buffer([0x01, 0x02, 0x03]), on_client_write);
    }

    function on_server_listen() {
        client.on('disconnected', on_disconnected);
        client.connect(host, port, on_client_connect);
    }

    server.listen(port, on_server_listen);
});

test('Client connect -> (client write full frame -> server response full frame) x 10 -> client disconnect', function(t) {
    var client = create_client(),
        server = create_server(),
        deferred = when.defer(),
        rpc_id = 1,
        buf = new Buffer([0x01, 0x02, 0x03]);

    function on_server_close() {

    }

    function on_done() {
        server.close(on_server_close);
    }

    function on_client_connect(err) {
        if (err) {
            errback(t, err, server);
            return;
        }

        (function next(iteration) {
            if (iteration >= 10) {
                t.ok(true, 'Client can perform multiple write/receive cycles');
                t.end();
                on_done();
                return;
            }
            client.write(rpc_id, buf, function on_client_write(err, frame) {
                if (err) {
                    errback(t, err, server);
                    return;
                }
                next(iteration + 1);
            });
        })(0);
    }

    function on_server_listen() {
        client.connect(host, port, on_client_connect);
    }

    server.listen(port, on_server_listen);
});

function errback(t, err, server) {
    t.ok(false, 'Error caught: ' + util.inspect(err));
    t.end();
    server.close();
}

function create_client(options) {
    return new FramingSocket(options);
}

function create_server(options) {
    return new TestSocketServer(options);
}






