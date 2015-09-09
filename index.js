'use strict';

// noinspection JSUnresolvedVariable
const Cu = Components.utils;
// noinspection JSUnresolvedVariable
const __dirname = __URI__.substring(0, __URI__.lastIndexOf('/'));

function require(id) {
    id = id.replace('./', __dirname + '/');
    return Cu.import(id, {});
}

const commonjs = {
    get api() {
        return this._api;
    },
    init: function () {
        this._api = require('./globals.jsm');
    },
    finalize: function () {
        this._api = null;
    },
};
const EXPORTED_SYMBOLS = ['commonjs'];
