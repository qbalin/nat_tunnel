"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class Address {
    constructor(host, port) {
        this.host = host;
        this.port = port;
    }
    toString() {
        return `${this.host}:${this.port}`;
    }
    equals(other) {
        return (other === null || other === void 0 ? void 0 : other.host) === this.host && other.port === this.port;
    }
}
exports.default = Address;
