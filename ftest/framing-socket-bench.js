/**
 * Performance test for FramingSocket.
 * Inspired by (and mostly copied from) multi_bench.js from node_redis
 * (http://github.com/mranney/node_redis)
 *
 * Command line parameters can be provided to influence the test:
 *
 * > node framing-socket-bench.js <server> <port> <num_sockets> <num_rpcs>
 *
 * Where:
 *     <host>           = server to connect to [localhost]
 *     <port>           = server port [8118]
 *     <num_sockets>    = Number of clients to create [5]
 *     <num_rpcs>       = Number of total RPCs each client
 *                        will try to complete. [20000]
 *
 * Host can have a special value called 'loopback' which will disable networking
 * altogether. A special socket implementation will just emit all the data that
 * is written to it (echo).
 */

var host = process.argv[2] || 'localhost',
    port = parseInt(process.argv[3], 10) || 8118,
    num_sockets = parseInt(process.argv[4], 10) || 5,
    num_rpcs = parseInt(process.argv[5], 10) || 20000,
    FramingSocket = require_FramingSocket((host === 'loopback')),
    metrics = require('metrics'),
    util = require('util'),
    metrics_enabled = false,
    tests = [],
    rpc_id = 0; // incrementing rpc id to use for the frame


/**
 * Test types
 */
var payloads = [
        new Buffer((new Array(51)).join('-')),
        new Buffer((new Array(4097)).join('-'))
    ],
    pipelines = [1, 20, 200, 10000];


/**
 * Define a Test class that will perform performance tests.  It is influenced
 * by the Ctor parameters to tell it what type of load to use.
 */
function Test(payload, concurrency) {
    /**
     * Describes the test for logging
     */
    this.description = 'Payload: ' + payload.length + ' bytes / ' + concurrency + ' concurrency';

    /**
     * The buffer data to send over the wire
     */
    this.payload = payload;

    /**
     * The maximum number of concurrent requests to allow before throttling
     */
    this.concurrency = concurrency;

    /**
     * Keeps track of all the sockets for this Test run
     */
    this.sockets = [];

    /**
     * The callback set on the start of tests.  This will be called
     * when the tests are complete.
     */
    this.start_callback = null;

    /**
     * The timestamp of when the tests started.  We use this to keep track
     * of how long the tests took.
     */
    this.start_timestamp = null;

    /**
     * Keeps track of sent RPCs
     */
    this.rpcs_sent = 0;

    /**
     * Number of RPCs that have received results
     */
    this.rpcs_received = 0;

    /**
     * Track number of rpcs failed
     */
    this.rpcs_failed = 0;

    /**
     * Measures the connect time
     */
    this.connect_latency = new metrics.Histogram();

    /**
     * Measure the time to receive a rpc response for the rpc request payload
     */
    this.rpc_latency = new metrics.Histogram();
}

/**
 * Entry point to start tests.  It creates num_socket sockets.  When all the
 * sockets are connected successfully, it kicks off the next stage.
 */
Test.prototype.run = function(callback) {
    var self = this,
        i,
        num_created = 0;

    function on_create_socket() {
        num_created++;
        if (num_created >= self.sockets.length) {
            self.on_connected();
        }
    }

    // TODO: we're not bothering to check here if tests are already started...
    this.start_callback = callback;
    for (i = 0; i < num_sockets; i++) {
        this.create_socket(i, on_create_socket);
    }
};

/**
 * Creates a new FramingSocket and connects it to the provided server host/port.
 * It also keeps track of connection timings.
 */
Test.prototype.create_socket = function(socket_id, callback) {
    var self = this,
        socket = new FramingSocket();

    function on_socket_connect() {
        self.connect_latency.update(Date.now() - socket._create_time);
        callback();
    }

    function on_socket_disconnected(host, port, err) {
        console.log(err);
    }

    // keep track of when the socket was created
    if (metrics_enabled) {
        socket.enable_metrics();
    }
    socket._create_time = Date.now();
    socket.on('disconnected', on_socket_disconnected);
    this.sockets[socket_id] = socket;
    socket.connect(host, port, on_socket_connect);
};

/**
 * Called when all the sockets are connected
 */
Test.prototype.on_connected = function() {
    console.log(
        left_pad(this.description, 13) + ", " +
        left_pad(this.concurrency, 5) + "/" +
        this.sockets.length + " "
    );
    this.start_timestamp = Date.now();
    this.fill_pipeline();
};

/**
 * Throttles the RPCs based on the configured concurrency value.
 * While the limit is not reached, this will try to fill up the pipeline
 * with more requests.  As responses come in, they will be
 */
Test.prototype.fill_pipeline = function() {
    var total_done = this.rpcs_received + this.rpcs_failed,
        pipeline = this.rpcs_sent - total_done;

    while (this.rpcs_sent < num_rpcs && pipeline < this.concurrency) {
        this.rpcs_sent++;
        pipeline++;
        this.send_rpc();
    }
    if (total_done === num_rpcs) {
        this.print_stats();
        this.stop_sockets();
    }
};

/**
 * Sends the actual payload data to the server and takes care of
 * response to the RPC.
 */
Test.prototype.send_rpc = function() {
    var self = this,
        start = Date.now(),
        socket = this.sockets[this.rpcs_sent % this.sockets.length];

    function on_socket_response(err, frame) {
        if (err) {
            self.rpcs_failed++;
            return;
        }

        self.rpc_latency.update(Date.now() - start);
        self.rpcs_received++;
        self.fill_pipeline();
    }

    socket.write(rpc_id++, this.payload, on_socket_response);
};

/**
 * Shuts down all open sockets and resolves the
 */
Test.prototype.stop_sockets = function() {
    this.sockets.forEach(function stop_sockets_forEach(socket) {
        socket.close();
    });
    this.start_callback();
};

Test.prototype.print_stats = function () {
    var duration = Date.now() - this.start_timestamp;

    console.log(
        "min/max/avg/p95: " +
        format_histogram_data(this.rpc_latency) + " " +
        left_pad(duration, 6) + "ms total, " +
        left_pad((num_rpcs / (duration / 1000)).toFixed(2), 8) + " ops/sec, " +
        left_pad(this.rpcs_failed, 6) + " RPCs rejected"
    );
    if (metrics_enabled) {
        this.sockets.forEach(function (socket) {
            console.log(format_metrics_data(socket));
        });
    }
};

function require_FramingSocket(loopback_socket) {
    var FramingBuffer = require('framing-buffer'),
        OffsetBuffer = require('offset-buffer'),
        util = require('util'),
        events = require('events'),
        metrics = require('metrics'),
        debug = false,
        net = loopback_socket ? require('./loopback-net.js') : require('net'),
        errors = require('../errors.js')(util);

    return require('../framing-socket.js')(
        FramingBuffer,
        OffsetBuffer,
        debug,
        metrics,
        net,
        events,
        util,
        errors,
        console
    );
}

/**
 * Adds padding to the left of a passed in string if required
 */
function left_pad(input, len, chr) {
    var str = input.toString();

    chr = chr || " ";
    while (str.length < len) {
        str = chr + str;
    }
    return str;
}

/**
 * Fancy formats the metrics.Histogram data
 */
function format_histogram_data(histogram) {
    var obj = histogram.printObj();

    return (
            left_pad(obj.min, 4) + "/" +
            left_pad(obj.max, 4) + "/" +
            left_pad(obj.mean.toFixed(2), 7) + "/" +
            left_pad(obj.p95.toFixed(2), 7)
        );
}

/**
 * Fancy formats the FramingSocket's metrics data (if collected)
 */
function format_metrics_data(socket) {
    var line = '',
        metric;
    Object.keys(socket.metrics).forEach(function (key) {
        metric = socket.metrics[key];
        line += key + ': ' + util.inspect(metric.printObj()) + '\n';
    });
    return line;
}

function next() {
    var test = tests.shift();

    function on_test_done() {
        next();
    }

    if (test) {
        test.run(on_test_done);
    } else {
        console.log("End of tests.");
        process.exit(0);
    }
}



// -------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------

payloads.forEach(function per_payload(payload) {
    pipelines.forEach(function per_pipeline(pipeline) {
        tests.push(new Test(payload, pipeline));
    });
});

next();



