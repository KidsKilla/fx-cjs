'use strict';

// noinspection JSUnresolvedVariable
const comps = Components;
// noinspection JSUnresolvedVariable
const __dirname = __URI__.substring(0, __URI__.lastIndexOf('/'));
const Cu = comps.utils;

const GRE_MODULES_PATH = 'resource://gre/modules/';
const GRE_COMPS_PATH = 'resource://gre/components/';
function require(id) {
    let rid = id
        .replace('gre/', GRE_MODULES_PATH)
        .replace('./', __dirname + '/');
    return Cu.import(rid, {});
}

const ConsoleAPI = require('gre/devtools/Console.jsm').ConsoleAPI;
const console = new ConsoleAPI({consoleID: ''});
const NetUtil = require('gre/NetUtil.jsm').NetUtil;
const Services = require('gre/Services.jsm').Services;
const XPCOMUtils = require('gre/XPCOMUtils.jsm').XPCOMUtils;
const sdk = require('gre/commonjs/toolkit/loader.js');

/*global TCPSocket*/
XPCOMUtils.defineLazyGetter(this, 'TCPSocket', () => loadGreComponent('TCPSocket.js').TCPSocket);

// yes, double Loader; yes, without 'new'
const sdkCfg = sdk.Loader.Loader({
    rootURI: GRE_MODULES_PATH,
    id: 'esync',
    name: 'esync',
    isNative: true,
    sharedGlobal: true,
    paths: {
        'sdk/': GRE_MODULES_PATH + 'commonjs/sdk/',
        'toolkit/': GRE_MODULES_PATH + 'commonjs/toolkit/',
        '': GRE_MODULES_PATH
    },
});

const CC = comps.Constructor;
const MODULES = new Map([
    ['xpcom', XPCOMUtils],
    ['svc', Services],
    ['chrome', sdkCfg.modules[GRE_MODULES_PATH + 'chrome.js'].exports],
]);

[
    // + global/...
    'ChromeWorker',
    'MessagePort',
    'Worker'
].forEach(n => MODULES.set('global/' + n, this[n]));

// Object.create(Components).utils throws
const Cc = comps.classes;
const Ci = comps.interfaces;
const COMPS = {
    createInstance: (contract, iface) => Cc[contract].createInstance(Ci[iface]),
    getService: (contract, iface) => Cc[contract].getService(Ci[iface]),
    createClass: (contract, iface, mtd) =>
        mtd
            ? CC(contract, Ci[iface], mtd)
            : CC(contract, Ci[iface]),
    isSuccessCode: code => Components.isSuccessCode(code),
};

[
    'Constructor',
    'Exception',
    'ID',
    'classes',
    'classesByID',
    'interfaces',
    'interfacesByID',
    'lastResult',
    'manager',
    'results',
    'returnCode',
    'stack',
    'utils'
].forEach(name => COMPS[name] = comps[name]);

MODULES.set('comps', COMPS);

MODULES.set('qi', {
    gen: function (nsiNames, obj) {
        nsiNames.push('nsIInterfaceRequestor', 'nsISupports');
        obj.QueryInterface = XPCOMUtils.generateQI(nsiNames.map(n => Ci[n]));
        obj.getInterface = obj.QueryInterface;
        return obj;
    },
    cast: function (obj, nsi) {
        return obj.QueryInterface(Ci[nsi]);
    }
});

let XHR = CC('@mozilla.org/xmlextras/xmlhttprequest;1', 'nsIXMLHttpRequest');
MODULES.set('cert-ignore', {
    createNotifier: fn => new ProblemNotifier(fn),
    xhr: function (url, fn) {
        let xhr = new XHR({mozSystem: true});
        xhr.mozBackgroundRequest = true;
        xhr.open('GET', url, true);
        xhr.channel.notificationCallbacks = this.createNotifier(
                override => override(xhr.channel.URI.asciiHost, xhr.channel.URI.port, true)
        );
        xhr.onloadend = fn;
        xhr.send();
    },
    socket: function (host, port, fn) {
        let err;
        let tcpSocket = new TCPSocket().open(host, port, {useSSL: true});
        tcpSocket.onerror = (evt) => {
            err = evt.data;
            tcpSocket.close();
        };
        tcpSocket.onclose = (evt) => {
            fn(err);
        };

        tcpSocket.ondata = (evt) => {
            tcpSocket.close();
        };

        tcpSocket.onopen = (evt) => {
            tcpSocket._transport.securityCallbacks = this.createNotifier(override => {
                override(host, port, true);
                tcpSocket.close();
            });
            tcpSocket.upgradeToSecure();
        };
    }
});

let path = sdk.Loader.main(sdkCfg, 'sdk/fs/path.js');
MODULES.set('path', {
    join: path.join,
    // FIXME: implement properly
    resolve: p => p,
});

function loadGreComponent(subpath) {
    let o = {};
    Services.scriptloader.loadSubScript(GRE_COMPS_PATH + subpath, o);
    return o;
}

function log() {
    Cu.reportError('!!!> ' + [].join.call(arguments, ' '));
}

// FIXME: find a better way
const INSTANCE_RELATED_MODULES = new Map([
    ['xb', reqr => ({
        abs: reqr._abs.bind(reqr),
        unabs: reqr._unabs.bind(reqr),
    })],

    ['fs', reqr => ({
        readFileSync: function (path, charset) {
            charset = charset || 'UTF-8';
            let realPath = reqr.revertPath(path);

            let stream = NetUtil.newChannel(realPath, charset, null).open();
            let data = NetUtil.readInputStreamToString(
                stream,
                stream.available(),
                {charset: charset}
            );
            stream.close();
            return {
                toString: () => data
            };
        }
    })]
]);

/**
 *
 * ALIAS
 */
const MODULES_PATH = 'resource:///modules/';
const ALIASES = new Map([
    ['greco/', loadGreComponent],
    ['gre/', subpath => Cu.import(GRE_MODULES_PATH + subpath)],
    ['sdk/', subpath => sdk.Loader.main(sdkCfg, 'sdk/' + subpath)],
    ['modules/', subpath => Cu.import(MODULES_PATH + subpath)],

    ['dom-parser', () => CC('@mozilla.org/xmlextras/domparser;1', 'nsIDOMParser')],
    ['xml-serializer', ()=> CC('@mozilla.org/xmlextras/xmlserializer;1', 'nsIDOMSerializer')],
]);

function addModules(reqr, globalModules) {
    MODULES.forEach((mdl, id) => reqr.aliasModule(id, mdl));
    ALIASES.forEach((alias, prePath) => reqr.alias(prePath, alias));
    INSTANCE_RELATED_MODULES.forEach(
        (getModule, moduleName) => reqr.aliasModule(moduleName, getModule(reqr))
    );
    Object.keys(globalModules).forEach(
            name => reqr.aliasModule('global/' + name, globalModules[name])
    );
}

function ProblemNotifier(onProblem) {
    this.socketInfo = null;
    this.sslStatus = null;
    this.targetHost = null;
    this.notifyCertProblem = function (socketInfo, sslStatus, targetHost) {
        this.socketInfo = socketInfo;
        this.sslStatus = sslStatus;
        this.targetHost = targetHost;
        onProblem((host, port, isTemp) => ProblemNotifier.override(sslStatus, host, port, isTemp));
        return true;
    }.bind(this);
}

ProblemNotifier.override = function (sslStatus, host, port, isTemp) {
    try {
        let certOverride = MODULES.get('comps').getService(
            '@mozilla.org/security/certoverride;1',
            'nsICertOverrideService'
        );
        sslStatus.QueryInterface(Ci.nsISSLStatus);

        let flags = 0;
        flags |= certOverride.ERROR_UNTRUSTED; // sslStatus.isUntrusted
        flags |= certOverride.ERROR_MISMATCH; // sslStatus.isDomainMismatch
        flags |= certOverride.ERROR_TIME; // sslStatus.isNotValidAtThisTime

        certOverride.rememberValidityOverride(host, port, sslStatus.serverCert, flags, isTemp);
    } catch (e) {
        console.error(e);
    }
};

ProblemNotifier.prototype = MODULES.get('qi').gen(['nsIBadCertListener2'], {});

const exports = {
    addModules: addModules
};
const EXPORTED_SYMBOLS = Object.keys(exports);
