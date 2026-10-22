'use strict';
/**
 * Is this error a PostgreSQL / PgBouncer connection going away (not a query failing)?
 * Used by the process-level handler to tell an expected drop during shutdown from a real crash.
 */

// SQLSTATE class 08 (connection exception) and the 57P0x shutdown codes.
const PG_CONNECTION_CODES = new Set(['08000', '08001', '08003', '08004', '08006', '57P01', '57P02', '57P03']);
const SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT']);
const MESSAGES = [
    /Connection terminated unexpectedly/i,
    /Connection terminated/i,
    /terminating connection/i,
    /Client has encountered a connection error and is not queryable/i,
    /server closed the connection unexpectedly/i,
    /server conn crashed/i,           // PgBouncer
    /server shutting down/i,          // PgBouncer
];

function isPgConnectionError(err) {
    if (!err || typeof err !== 'object') return false;
    if (PG_CONNECTION_CODES.has(err.code)) return true;
    const msg = String(err.message || '');
    if (MESSAGES.some((re) => re.test(msg))) return true;
    // A bare socket error counts only when it came out of the pg driver.
    const stack = String(err.stack || '');
    return SOCKET_CODES.has(err.code) && /node_modules[\\/](pg|pg-pool|pg-protocol)[\\/]/.test(stack);
}

module.exports = { isPgConnectionError };
