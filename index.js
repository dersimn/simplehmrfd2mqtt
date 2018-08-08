#!/usr/bin/env node

const pkg = require('./package.json');
const log = require('yalm');
const config = require('yargs')
    .env('HOMEMATIC2MQTT')
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('verbosity', 'possible values: "error", "warn", "info", "debug"')
    .describe('name', 'instance name. used as mqtt client id and as prefix for connected topic')
    .describe('mqtt-url', 'mqtt broker url. See https://github.com/mqttjs/MQTT.js#connect-using-a-url')
    .describe('polling-interval', 'polling interval (in ms) for status updates')
    .describe('ccu-address', 'CCU address')
    .describe('init-address', 'Own IP for callbacks')
    .describe('listen-port', 'Own Port for callbacks')
    .alias({
        h: 'help',
        m: 'mqtt-url',
        b: 'ccu-address',
        l: 'init-address',
        p: 'listen-port',
        v: 'verbosity'
    })
    .default({
        name: 'hm',
        'mqtt-url': 'mqtt://127.0.0.1',
        'polling-interval': 3000,
        'listen-port': 2126
    })
    .version()
    .help('help')
    .argv;
const MqttSmarthome = require('mqtt-smarthome-connect');
const xmlrpc = require('xmlrpc');

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug("loaded config: ", config);

log.info('mqtt trying to connect', config.mqttUrl);
const mqtt = new MqttSmarthome(config.mqttUrl, {
    logger: log,
    will: {topic: config.name + '/maintenance/_bridge/online', payload: 'false', retain: true}
});
mqtt.connect();

var server = xmlrpc.createServer({
    host: '0.0.0.0',
    port: config.listenPort
});
var client = xmlrpc.createClient({
    host: config.ccuAddress,
    port: 2001,
    path: '/'
});

function methodCall(method, parameters) {
    return new Promise((resolve, reject) => {
        client.methodCall(method, parameters, (error, value) => {
            if ( error ) {
                reject(error);
            } else {
                resolve(value);
            }
        });
    });
}

mqtt.on('connect', () => {
    log.info('mqtt connected', config.mqttUrl);
    mqtt.publish(config.name + '/maintenance/_bridge/online', 'true', {retain: true});
});

const rpcMethods = {
    notFound: method => {
        log.debug('rpc < Method ' + method + ' does not exist');
    },
    'system.multicall': (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        const res = [];
        params[0].forEach(c => {
            if (rpcMethods[c.methodName]) {
                rpcMethods[c.methodName](err, c.params);
            } else {
                rpcMethods.notFound(c.methodName, c.params);
            }
            res.push('');
        });
        callback(null, res);
    },
    'system.listMethods': (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        log.debug('rpc < system.listMethods', params);
        callback(null, Object.keys(rpcMethods));
    },
    event: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        log.debug('rpc < event', JSON.stringify(params));

        const address = params[1];
        const datapoint = params[2];
        const value = params[3];

        if (!datapoint.startsWith('PARTY_')) {
            mqtt.publish(config.name+'/status/'+address+'/'+datapoint, {'val': value});
        }

        if (typeof callback === 'function') {
            callback(null, '');
        }
    }
};
Object.keys(rpcMethods).forEach(method => {
    server.on(method, rpcMethods[method]);
});

log.info('rpc', '> init');
methodCall('init', ['http://'+config.initAddress+':'+config.listenPort, 'hm2mqtt_rfd']).catch(err => {
    log.error(err);
});

function stop() {
    log.info('rpc', '> stop');
    methodCall('init', ['http://'+config.initAddress+':'+config.listenPort, '']).catch(err => {
        log.error(err);
    });
    process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);