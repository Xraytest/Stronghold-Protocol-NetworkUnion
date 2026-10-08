// test/share-origin.test.js — pure unit tests of the share-link origin rules (DESIGN §27.1).
//
// shared/origin.js is the anti-phishing boundary: a client-supplied origin is attacker-controlled input that can end
// up in another player's clipboard, so a value with a path/query/fragment/credentials, a non-http(s) scheme or a
// non-canonical spelling must be refused, and a configured allowlist is EXCLUSIVE. `Lobby.resolveOrigin` is the
// server-side entry point; it is exercised through a real Lobby instance.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalOrigin, originFromHost, parseOriginList, pickShareOrigin, ORIGIN_MAX_LEN } from '../shared/origin.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** A real Lobby with the given options (only resolveOrigin is used here). */
const lobbyWith = (options = {}) => new Lobby({ registry: new SessionRegistry(), log: silent, options });

describe('shared/origin.js', () => {
  describe('canonicalOrigin', () => {
    test('accepts the exact canonical spelling and normalises case/default ports', () => {
      for (const o of [
        'https://game.example',
        'http://localhost:3000',
        'https://[2001:db8::1]:8443',
        'http://127.0.0.1:8080',
        'http://[::1]:3000',
      ]) {
        assert.equal(canonicalOrigin(o), o);
      }
      assert.equal(canonicalOrigin('HTTPS://GAME.EXAMPLE'), 'https://game.example', 'scheme/host lower-cased');
      assert.equal(canonicalOrigin('https://game.example:443'), 'https://game.example', 'default port dropped');
      assert.equal(canonicalOrigin('https://game.example/'), 'https://game.example', 'the empty path is canonical');
      // a non-ASCII host is punycoded by the WHATWG parser (the canonical form is the ASCII one)
      assert.equal(canonicalOrigin('https://例え.jp'), new URL('https://例え.jp').origin);
      assert.match(canonicalOrigin('https://例え.jp'), /^https:\/\/xn--/);
    });

    test('rejects a path, a query, a fragment, credentials and non-http(s) schemes', () => {
      for (const bad of [
        'https://host/x', 'https://host/x/', 'https://host//', 'https://host/a/b',
        'https://host?x=1', 'https://host/#f', 'https://host?x=1#f',
        'https://user:pw@host', 'https://user@host',
        'file://x', 'javascript:alert(1)', 'data:text/plain,x', 'ftp://host', 'ws://host', 'chrome://x',
        'null', '', 'not a url', '//host', 'host',
      ]) {
        assert.equal(canonicalOrigin(bad), null, JSON.stringify(bad));
      }
      for (const nonString of [null, undefined, 42, {}, [], true]) {
        assert.equal(canonicalOrigin(nonString), null, JSON.stringify(nonString));
      }
    });

    test('rejects a value past ORIGIN_MAX_LEN', () => {
      const long = `https://${'a'.repeat(ORIGIN_MAX_LEN)}.example`;
      assert.ok(long.length > ORIGIN_MAX_LEN);
      assert.equal(canonicalOrigin(long), null);
      const borderline = `https://${'a'.repeat(ORIGIN_MAX_LEN - 'https://'.length)}`; // exactly at the cap
      assert.equal(borderline.length, ORIGIN_MAX_LEN);
      assert.equal(canonicalOrigin(borderline), borderline);
    });
  });

  describe('originFromHost', () => {
    test('a host with or without a port, and the scheme from the proxy', () => {
      assert.equal(originFromHost('game.example'), 'http://game.example');
      assert.equal(originFromHost('game.example', 'http'), 'http://game.example');
      assert.equal(originFromHost('game.example', 'https'), 'https://game.example');
      assert.equal(originFromHost('game.example:8443', 'https'), 'https://game.example:8443');
      assert.equal(originFromHost('127.0.0.1:8080', 'https'), 'https://127.0.0.1:8080');
      assert.equal(originFromHost('[::1]:3000', 'http'), 'http://[::1]:3000');
      assert.equal(originFromHost('GAME.example', 'http'), 'http://game.example', 'lower-cased');
      assert.equal(originFromHost('game.example', 'bogus'), 'http://game.example', 'a non-https proto is http');
    });

    test('garbage input is refused instead of escaping into the URL parser', () => {
      for (const bad of ['', null, undefined, 42, {}, 'host with space', 'host/path', 'host?x', 'host#f', 'a.example, b.example', ':80', 'host\nfoo', 'host@evil', 'host\\evil']) {
        assert.equal(originFromHost(bad, 'http'), null, JSON.stringify(bad));
      }
      assert.equal(originFromHost('a'.repeat(256), 'http'), null, 'over-long host');
      // a host valid at HOST_MAX_LEN still cannot exceed the ORIGIN_MAX_LEN canonical-origin cap
      assert.equal(originFromHost('a'.repeat(255), 'http'), null);
    });
  });

  describe('parseOriginList', () => {
    test('comma/space separated, de-duplicated and canonicalised', () => {
      assert.deepEqual(parseOriginList('https://a.example,https://b.example'), {
        origins: ['https://a.example', 'https://b.example'], invalid: [],
      });
      assert.deepEqual(parseOriginList('https://a.example https://b.example'), {
        origins: ['https://a.example', 'https://b.example'], invalid: [],
      });
      assert.deepEqual(parseOriginList('https://a.example,  https://a.example , HTTPS://A.EXAMPLE'), {
        origins: ['https://a.example'], invalid: [],
      });
      assert.deepEqual(parseOriginList(''), { origins: [], invalid: [] });
      assert.deepEqual(parseOriginList(null), { origins: [], invalid: [] });
      assert.deepEqual(parseOriginList(undefined), { origins: [], invalid: [] });
    });

    test('reports invalid entries and keeps the good ones', () => {
      const { origins, invalid } = parseOriginList('https://a.example, not-a-url, https://b.example/x, file://x');
      assert.deepEqual(origins, ['https://a.example']);
      assert.deepEqual(invalid, ['not-a-url', 'https://b.example/x', 'file://x']);
    });
  });

  describe('pickShareOrigin', () => {
    test('an allowlist is EXCLUSIVE when non-empty', () => {
      const allow = ['https://a.example', 'https://b.example'];
      assert.equal(pickShareOrigin({ reported: 'https://a.example', connOrigin: 'http://localhost', allow }), 'https://a.example');
      assert.equal(pickShareOrigin({ reported: 'https://b.example', connOrigin: 'http://localhost', allow }), 'https://b.example');
      assert.equal(pickShareOrigin({ reported: 'https://evil.example', connOrigin: 'http://localhost', allow }), null);
      // matching the connection is not enough when an allowlist is pinned
      assert.equal(pickShareOrigin({ reported: 'https://evil.example', connOrigin: 'https://evil.example', allow }), null);
      // the connection's own origin is used only when it is itself allowlisted
      assert.equal(pickShareOrigin({ reported: 'https://evil.example', connOrigin: 'https://a.example', allow }), 'https://a.example');
      assert.equal(pickShareOrigin({ reported: null, connOrigin: 'https://b.example', allow }), 'https://b.example');
    });

    test('without an allowlist only the connection origin is trusted', () => {
      assert.equal(pickShareOrigin({ reported: 'https://a.example', connOrigin: 'https://a.example' }), 'https://a.example');
      assert.equal(pickShareOrigin({ reported: 'https://evil.example', connOrigin: 'https://a.example' }), 'https://a.example',
        'a spoofed report falls back to the address this connection arrived on');
      assert.equal(pickShareOrigin({ reported: null, connOrigin: 'https://a.example' }), 'https://a.example');
      assert.equal(pickShareOrigin({ reported: 'https://evil.example', connOrigin: null }), null);
      assert.equal(pickShareOrigin({ reported: 'https://evil.example', connOrigin: null, allow: [] }), null);
      assert.equal(pickShareOrigin({}), null);
      assert.equal(pickShareOrigin({ reported: 'https://a.example', connOrigin: 'https://a.example', allow: [] }), 'https://a.example');
      // a non-string report can never win
      assert.equal(pickShareOrigin({ reported: 42, connOrigin: 'https://a.example' }), 'https://a.example');
    });
  });
});

describe('Lobby.resolveOrigin', () => {
  test('an allowlist is exclusive even when the report matches the connection', () => {
    const lobby = lobbyWith({ publicOrigins: 'https://a.example,https://b.example' });
    assert.equal(lobby.resolveOrigin({}, 'https://a.example', 'http://localhost:1'), 'https://a.example');
    assert.equal(lobby.resolveOrigin({}, 'https://b.example', 'http://localhost:1'), 'https://b.example');
    assert.equal(lobby.resolveOrigin({}, 'https://evil.example', 'http://localhost:1'), null);
    assert.equal(lobby.resolveOrigin({}, 'http://localhost:1', 'http://localhost:1'), null, 'an unlisted origin is refused even when it is the connection');
    assert.equal(lobby.resolveOrigin({}, null, 'https://b.example'), 'https://b.example', 'a silent client gets an allowlisted connection origin');
    assert.equal(lobby.resolveOrigin({}, 'https://a.example/x', 'https://a.example'), 'https://a.example',
      'a malformed report is discarded, never returned; the allowlisted connection origin is used');
  });

  test('without an allowlist: the report must equal the connection origin', () => {
    const lobby = lobbyWith();
    assert.equal(lobby.resolveOrigin({}, 'https://a.example', 'https://a.example'), 'https://a.example');
    assert.equal(lobby.resolveOrigin({}, 'https://evil.example', 'https://a.example'), 'https://a.example');
    assert.equal(lobby.resolveOrigin({}, null, 'https://a.example'), 'https://a.example');
    assert.equal(lobby.resolveOrigin({}, null, null), null);
    // a malformed report is canonicalised to null and cannot override the connection
    assert.equal(lobby.resolveOrigin({}, 'https://a.example/x', 'https://a.example'), 'https://a.example');
    assert.equal(lobby.resolveOrigin({}, 'javascript:alert(1)', 'https://a.example'), 'https://a.example');
  });

  test('shareLink:false never answers an origin', () => {
    const lobby = lobbyWith({ shareLink: false, publicOrigins: 'https://a.example' });
    assert.equal(lobby.resolveOrigin({}, 'https://a.example', 'https://a.example'), null);
    assert.equal(lobby.resolveOrigin({}, null, 'https://a.example'), null);
    assert.equal(lobby.resolveOrigin({}, 'https://evil.example', 'https://a.example'), null);
  });
});
