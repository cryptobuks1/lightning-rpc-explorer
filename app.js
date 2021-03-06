#!/usr/bin/env node

'use strict';

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var session = require("express-session");
var config = require("./app/config.js");
var simpleGit = require('simple-git');
var utils = require("./app/utils.js");
var moment = require("moment");
var Decimal = require('decimal.js');
var bitcoinCore = require("bitcoin-core");
var grpc = require("grpc");
var fs = require("fs");
var pug = require("pug");
var momentDurationFormat = require("moment-duration-format");
var coins = require("./app/coins.js");
var request = require("request");
var qrcode = require("qrcode");
var rpcApi = require("./app/rpcApi.js");
var Influx = require("influx");


var baseActionsRouter = require('./routes/baseActionsRouter');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));

// ref: https://blog.stigok.com/post/disable-pug-debug-output-with-expressjs-web-app
app.engine('pug', (path, options, fn) => {
  options.debug = false;
  return pug.__express.call(null, path, options, fn);
});

app.set('view engine', 'pug');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(session({
	secret: config.cookiePassword,
	resave: false,
	saveUninitialized: false
}));
app.use(express.static(path.join(__dirname, 'public')));


function logNetworkStats() {
	if (global.influxdb) {
		rpcApi.getNetworkStats().then(function(response) {
			var vals = [];
			for (var x in response) {
				var valX = response[x];

				if (x == "total_network_capacity") {
					valX = parseInt(valX);
				}

				vals.push({measurement:("lightning.network." + x), fields:{value:valX}})
			}

			global.influxdb.writePoints(vals).catch(err => {
				console.error(`Error saving data to InfluxDB: ${err.stack}`)
			});
		});
	}
}



app.runOnStartup = function() {
	global.config = config;
	global.coinConfig = coins[config.coin];
	global.coinConfigs = coins;

	if (config.credentials.influxdb.active) {
		global.influxdb = new Influx.InfluxDB(config.credentials.influxdb);

		console.log(`Connected to InfluxDB: ${config.credentials.influxdb.host}:${config.credentials.influxdb.port}/${config.credentials.influxdb.database}`);
	}

	if (config.donationAddresses) {
		var getDonationAddressQrCode = function(coinId) {
			qrcode.toDataURL(config.donationAddresses[coinId].address, function(err, url) {
				global.donationAddressQrCodeUrls[coinId] = url;
			});
		};

		global.donationAddressQrCodeUrls = {};

		config.donationAddresses.coins.forEach(function(item) {
			getDonationAddressQrCode(item);
		});
	}

	if (global.sourcecodeVersion == null) {
		simpleGit(".").log(["-n 1"], function(err, log) {
			global.sourcecodeVersion = log.all[0].hash.substring(0, 10);
			global.sourcecodeDate = log.all[0].date.substring(0, "0000-00-00".length);
		});
	}


	if (global.exchangeRates == null) {
		utils.refreshExchangeRates();
	}

	// refresh exchange rate periodically
	setInterval(utils.refreshExchangeRates, 30 * 60000);

	// connect and pull down the current network description
	connectViaRpc().then(function() {
		rpcApi.refreshFullNetworkDescription();
		rpcApi.refreshLocalChannels();

		// refresh periodically
		setInterval(rpcApi.refreshFullNetworkDescription, 60000);
		setInterval(rpcApi.refreshLocalChannels, 60000);

		setInterval(logNetworkStats, 5 * 60000);
	});
};

function connectViaRpc() {
	return new Promise(function(resolve, reject) {
		// Ref: https://github.com/lightningnetwork/lnd/blob/master/docs/grpc/javascript.md

		// Due to updated ECDSA generated tls.cert we need to let gprc know that
		// we need to use that cipher suite otherwise there will be a handhsake
		// error when we communicate with the lnd rpc server.
		process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA';

		// Lnd admin macaroon is at ~/.lnd/admin.macaroon on Linux and
		// ~/Library/Application Support/Lnd/admin.macaroon on Mac
		var m = fs.readFileSync(config.credentials.rpc.adminMacaroonFilepath);
		var macaroon = m.toString('hex');

		// build meta data credentials
		var metadata = new grpc.Metadata()
		metadata.add('macaroon', macaroon)
		var macaroonCreds = grpc.credentials.createFromMetadataGenerator((_args, callback) => {
			callback(null, metadata);
		});

		//  Lnd cert is at ~/.lnd/tls.cert on Linux and
		//  ~/Library/Application Support/Lnd/tls.cert on Mac
		var lndCert = fs.readFileSync(config.credentials.rpc.tlsCertFilepath);
		var sslCreds = grpc.credentials.createSsl(lndCert);

		// combine the cert credentials and the macaroon auth credentials
		// such that every call is properly encrypted and authenticated
		var credentials = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);

		var lnrpcDescriptor = grpc.load("./rpc.proto"); // "rpc.proto"
		var lnrpc = lnrpcDescriptor.lnrpc;

		// uncomment to print available function of RPC protocol
		//console.log(lnrpc);
		
		var lightning = new lnrpc.Lightning(config.credentials.rpc.host + ":" + config.credentials.rpc.port, credentials, {'grpc.max_receive_message_length': 50*1024*1024});

		lightning.GetInfo({}, function(err, response) {
			if (err) {
				console.log("Error connecting to LND @ " + config.credentials.rpc.host + ":" + config.credentials.rpc.port + " via RPC: " + err + ", error json: " + JSON.stringify(err));
			}

			if (response != null) {
				console.log("Connected to LND @ " + config.credentials.rpc.host + ":" + config.credentials.rpc.port + " via RPC.\n\nGetInfo=" + JSON.stringify(response, null, 4));
			}

			global.lightning = lightning;

			resolve();
		});
	});
}



app.use(function(req, res, next) {
	// make session available in templates
	res.locals.session = req.session;
	
	if (config.credentials.rpc) {
		req.session.host = config.credentials.rpc.host;
		req.session.port = config.credentials.rpc.port;
		req.session.username = config.credentials.rpc.username;

		global.client = new bitcoinCore({
			host: config.credentials.rpc.host,
			port: config.credentials.rpc.port,
			username: config.credentials.rpc.username,
			password: config.credentials.rpc.password,
			timeout: 5000
		});
	}

	res.locals.admin = false;

	req.session.userErrors = [];

	res.locals.config = global.config;
	res.locals.coinConfig = global.coinConfig;
	
	res.locals.host = req.session.host;
	res.locals.port = req.session.port;


	// currency format type
	if (!req.session.currencyFormatType) {
		var cookieValue = req.cookies['user-setting-currencyFormatType'];

		if (cookieValue) {
			req.session.currencyFormatType = cookieValue;

		} else {
			req.session.currencyFormatType = "";
		}
	}

	// theme
	if (!req.session.uiTheme) {
		var cookieValue = req.cookies['user-setting-uiTheme'];

		if (cookieValue) {
			req.session.uiTheme = cookieValue;

		} else {
			req.session.uiTheme = "";
		}
	}

	// homepage banner
	if (!req.session.hideHomepageBanner) {
		var cookieValue = req.cookies['user-setting-hideHomepageBanner'];

		if (cookieValue) {
			req.session.hideHomepageBanner = cookieValue;

		} else {
			req.session.hideHomepageBanner = "false";
		}
	}

	res.locals.currencyFormatType = req.session.currencyFormatType;


	if (!["/", "/connect"].includes(req.originalUrl)) {
		if (utils.redirectToConnectPageIfNeeded(req, res)) {
			return;
		}
	}
	
	if (req.session.userMessage) {
		res.locals.userMessage = req.session.userMessage;
		
		if (req.session.userMessageType) {
			res.locals.userMessageType = req.session.userMessageType;
			
		} else {
			res.locals.userMessageType = "warning";
		}

		req.session.userMessage = null;
		req.session.userMessageType = null;
	}

	if (req.session.userErrors && req.session.userErrors.length > 0) {
		res.locals.userErrors = req.session.userErrors;

		req.session.userErrors = null;
	}

	if (req.session.query) {
		res.locals.query = req.session.query;

		req.session.query = null;
	}

	// make some var available to all request
	// ex: req.cheeseStr = "cheese";

	rpcApi.getFullNetworkDescription().then(function(fnd) {
		res.locals.fullNetworkDescription = fnd;

		rpcApi.getLocalChannels().then(function(localChannels) {
			res.locals.localChannels = localChannels;

			next();

		}).catch(function(err) {
			utils.logError("37921hdasudfgd", err);

			next();
		});
	}).catch(function(err) {
		utils.logError("3297rhgdgvsf1", err);

		next();
	});
});

app.use('/', baseActionsRouter);

/// catch 404 and forwarding to error handler
app.use(function(req, res, next) {
	var err = new Error('Not Found');
	err.status = 404;
	next(err);
});

/// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
	app.use(function(err, req, res, next) {
		res.status(err.status || 500);
		res.render('error', {
			message: err.message,
			error: err
		});
	});
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
	res.status(err.status || 500);
	res.render('error', {
		message: err.message,
		error: {}
	});
});

app.locals.moment = moment;
app.locals.Decimal = Decimal;
app.locals.utils = utils;



module.exports = app;
