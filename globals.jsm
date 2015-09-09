'use strict';

// noinspection JSUnresolvedVariable
const __dirname = __URI__.substring(0, __URI__.lastIndexOf('/'));
// noinspection JSUnresolvedVariable
const comps = Components;

const Cu = comps.utils;
const Cc = comps.classes;
const Ci = comps.interfaces;

const GRE_PATH = 'resource://gre/modules/';

function require(id) {
    let rid = id
        .replace('gre/', GRE_PATH)
        .replace('./', __dirname + '/');
    return Cu.import(rid, {});
}

const Services = require('gre/Services.jsm').Services;
const SYSTEM_PRINCIPAL = Services.scriptSecurityManager.getSystemPrincipal();

const ConsoleAPI = require('gre/devtools/Console.jsm').ConsoleAPI;
const console = new ConsoleAPI({consoleID: ''});
const globalModules = require('./global-modules.js');
const Requirer = require('./require.jsm').Requirer;

/**
 *
 * JS GLOBALS
 */
const TIMERS = [];
function getTimer(callback, delay, args, type) {
    let timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
    timer.initWithCallback(
        {
            notify: args.length
                ? () => callback(...args)
                : callback
        },
        delay,
        type
    );
    return TIMERS.push(timer);
}

function cancelTimer(index) {
    // TODO: cleanup api
    let timer = TIMERS[index - 1];
    if (timer) {
        timer.cancel();
    }
}

// Symbol
const SYMBOL = k => {
    throw 'Symbols are not available until Fx 36.0\nYou can use safely only Symbol.iterator';
};
SYMBOL.iterator = '@@iterator';
SYMBOL.toStringTag = 'toString';
SYMBOL.toPrimitive = 'valueOf';
if (this.Symbol) {
    for (let k of Object.keys(SYMBOL)) {
        SYMBOL[k] = this.Symbol[k];
    }
}

const CUSTOM_GLOBAL = {
    console: console,
    setTimeout: (callback, delay, ...args) =>
        getTimer(callback, delay, args, Ci.nsITimer.TYPE_ONE_SHOT),
    setInterval: (callback, delay, ...args) =>
        getTimer(callback, delay, args, Ci.nsITimer.TYPE_REPEATING_PRECISE_CAN_SKIP),
    clearTimeout: cancelTimer,
    clearInterval: cancelTimer,
    Components: null,
    Symbol: SYMBOL,
    Promise: this.Promise || (function () {
        let grePromise = require('gre/Promise.jsm').Promise;

        function Promise(fn) {
            let defer = grePromise.defer();
            fn(defer.resolve, defer.reject);
            defer.promise.catch = onReject => defer.then(null, onReject);
            return defer.promise;
        }

        Promise.all = grePromise.all;
        Promise.race = function (aValues) {
            if (aValues == null || typeof(aValues[SYMBOL.iterator]) != 'function') {
                throw new Error('Promise.race() expects an iterable.');
            }
            return new Promise((resolve, reject) => {
                for (let value of aValues) {
                    Promise.resolve(value).then(resolve, reject);
                }
            });
        };
        Promise.resolve = function (aValue) {
            if (aValue && typeof(aValue) == 'function' && aValue.isAsyncFunction) {
                throw new TypeError(
                    'Cannot resolve a promise with an async function. ' +
                    'You should either invoke the async function first ' +
                    'or use "Task.spawn" instead of "Task.async" to start ' +
                    'the Task and return its promise.'
                );
            }
            if (aValue instanceof Promise) {
                return aValue;
            }
            return new Promise(resolve => resolve(aValue));
        };

        Promise.reject = reason => new Promise((_, reject) => reject(reason));
        return Promise;
    })()
};
const EXTRA_GLOBAL = [
    // Throws in FF 27
    // 'CSS',
    // 'URLSearchParams',
    // 'Blob',
    // 'File',
    'indexedDB',
    'XMLHttpRequest',
    'TextEncoder',
    'TextDecoder',
    'URL',
    'atob',
    'btoa',
];
const SANDBOX = Cu.Sandbox(SYSTEM_PRINCIPAL, {
    principal: SYSTEM_PRINCIPAL,
    sandboxPrototype: CUSTOM_GLOBAL,
    wantComponents: false,
    sandboxName: 'sdv',
    wantGlobalProperties: EXTRA_GLOBAL,
    invisibleToDebugger: false,
    metadata: {}
});
const IGNORED_GLOBALS = [
    'importFunction',
    'Iterator',
    'StopIteration'
];
const GLOBAL_MODULES = {};
EXTRA_GLOBAL.forEach(name => GLOBAL_MODULES[name] = SANDBOX[name]);
EXTRA_GLOBAL.concat(IGNORED_GLOBALS).forEach(name => delete SANDBOX[name]);

// TODO: discuss to use devtools/Loader.jsm
// let dtl = require('gre/modules/devtools/Loader.jsm');
// dtl.devtools.require('sdk/io/buffer')
// dtl.loaderGlobals.console
// dtl.loader.join

function createRequirer(rootPath) {
    const reqr = new Requirer(rootPath);
    reqr.setGlobals(SANDBOX);
    globalModules.addModules(reqr, GLOBAL_MODULES);
    return reqr;
}

const exports = {
    createRequirer: createRequirer,
};
const EXPORTED_SYMBOLS = Object.keys(exports);
