import { expect } from 'chai';
import { isPrivateUrl } from '../utils';

describe('isPrivateUrl', () => {
  // ── Public URLs — must NOT be blocked ──────────────────────────────────────

  it('allows a public HTTPS URL', () => {
    expect(isPrivateUrl('https://example.com/docs')).to.be.false;
  });

  it('allows a public HTTP URL', () => {
    expect(isPrivateUrl('http://docs.example.org/api')).to.be.false;
  });

  it('allows a URL with a port on a public host', () => {
    expect(isPrivateUrl('https://api.example.com:443/v1')).to.be.false;
  });

  it('allows a URL with a path and query on a public host', () => {
    expect(isPrivateUrl('https://raw.githubusercontent.com/owner/repo/main/README.md')).to.be.false;
  });

  // ── Loopback ────────────────────────────────────────────────────────────────

  it('blocks http://localhost', () => {
    expect(isPrivateUrl('http://localhost')).to.be.true;
  });

  it('blocks http://localhost:3000', () => {
    expect(isPrivateUrl('http://localhost:3000')).to.be.true;
  });

  it('blocks http://127.0.0.1', () => {
    expect(isPrivateUrl('http://127.0.0.1')).to.be.true;
  });

  it('blocks http://127.0.0.1:8080 (loopback with port)', () => {
    expect(isPrivateUrl('http://127.0.0.1:8080')).to.be.true;
  });

  it('blocks http://127.1.2.3 (loopback range)', () => {
    expect(isPrivateUrl('http://127.1.2.3')).to.be.true;
  });

  it('blocks http://0.0.0.0', () => {
    expect(isPrivateUrl('http://0.0.0.0')).to.be.true;
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(isPrivateUrl('http://[::1]/')).to.be.true;
  });

  // ── Link-local (AWS/GCP metadata) ──────────────────────────────────────────

  it('blocks http://169.254.169.254 (AWS metadata endpoint)', () => {
    expect(isPrivateUrl('http://169.254.169.254/latest/meta-data/')).to.be.true;
  });

  it('blocks any 169.254.x.x address', () => {
    expect(isPrivateUrl('http://169.254.0.1')).to.be.true;
  });

  // ── RFC-1918 private ranges ─────────────────────────────────────────────────

  it('blocks http://10.0.0.1 (10/8)', () => {
    expect(isPrivateUrl('http://10.0.0.1')).to.be.true;
  });

  it('blocks http://10.255.255.255 (10/8 high end)', () => {
    expect(isPrivateUrl('http://10.255.255.255')).to.be.true;
  });

  it('blocks http://172.16.0.1 (172.16/12 low end)', () => {
    expect(isPrivateUrl('http://172.16.0.1')).to.be.true;
  });

  it('blocks http://172.31.255.255 (172.16/12 high end)', () => {
    expect(isPrivateUrl('http://172.31.255.255')).to.be.true;
  });

  it('allows http://172.15.0.1 (just outside 172.16/12)', () => {
    expect(isPrivateUrl('http://172.15.0.1')).to.be.false;
  });

  it('allows http://172.32.0.1 (just outside 172.16/12)', () => {
    expect(isPrivateUrl('http://172.32.0.1')).to.be.false;
  });

  it('blocks http://192.168.1.1 (192.168/16)', () => {
    expect(isPrivateUrl('http://192.168.1.1')).to.be.true;
  });

  it('blocks http://192.168.0.100 (192.168/16)', () => {
    expect(isPrivateUrl('http://192.168.0.100')).to.be.true;
  });

  // ── Non-HTTP schemes ────────────────────────────────────────────────────────

  it('blocks file:// URLs', () => {
    expect(isPrivateUrl('file:///etc/passwd')).to.be.true;
  });

  it('blocks ftp:// URLs', () => {
    expect(isPrivateUrl('ftp://files.example.com')).to.be.true;
  });

  it('blocks unparseable strings', () => {
    expect(isPrivateUrl('not a url at all')).to.be.true;
  });

  it('blocks empty string', () => {
    expect(isPrivateUrl('')).to.be.true;
  });

  // ── IPv6 unique-local ───────────────────────────────────────────────────────

  it('blocks IPv6 fc00::/7 unique-local addresses', () => {
    expect(isPrivateUrl('http://[fc00::1]/')).to.be.true;
  });

  it('blocks IPv6 fd00::/8 unique-local addresses', () => {
    expect(isPrivateUrl('http://[fd12:3456:789a::1]/')).to.be.true;
  });
});
