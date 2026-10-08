'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../lib/protocol');

function manufacturerData({
  fan = 0, afterCookingSpeed = 0, flags = 0, filters = 0, dim = 0, period = 0,
} = {}) {
  return Buffer.concat([
    Buffer.from('HOODFJAR', 'ascii'),
    Buffer.from([fan, afterCookingSpeed, flags, filters, 0, dim, period]),
  ]);
}

test('parseManufacturerData reads all fields', () => {
  const state = protocol.parseManufacturerData(manufacturerData({
    fan: 3, afterCookingSpeed: 2, flags: 0b111, filters: 0b111, dim: 80, period: 30,
  }));
  assert.deepEqual(state, {
    fanSpeed: 3,
    afterCookingFanSpeed: 2,
    lightOn: true,
    afterCookingOn: true,
    periodicVentingOn: true,
    greaseFilterFull: true,
    carbonFilterFull: true,
    carbonFilterAvailable: true,
    dimLevel: 80,
    periodicVenting: 30,
  });
});

test('parseManufacturerData accepts data without company id', () => {
  const state = protocol.parseManufacturerData(manufacturerData({ fan: 5 }).slice(2));
  assert.equal(state.fanSpeed, 5);
});

test('parseManufacturerData rejects other devices and short data', () => {
  assert.equal(protocol.parseManufacturerData(Buffer.from('SOMETHINGELSE!', 'ascii')), null);
  assert.equal(protocol.parseManufacturerData(Buffer.from('HOODFJAR', 'ascii')), null);
  assert.equal(protocol.parseManufacturerData(null), null);
});

test('parseManufacturerData ignores out of range dim and period', () => {
  const state = protocol.parseManufacturerData(manufacturerData({ dim: 200, period: 99 }));
  assert.equal(state.dimLevel, null);
  assert.equal(state.periodicVenting, null);
});

test('parseManufacturerData ignores light on while dimming down from off', () => {
  const previous = { lightOn: false, dimLevel: 50 };
  const state = protocol.parseManufacturerData(manufacturerData({ flags: 1, dim: 10 }), previous);
  assert.equal(state.lightOn, false);
});

test('parseTxState reads state from characteristic', () => {
  const state = protocol.parseTxState(Buffer.from('12344LNCFK08015', 'ascii'));
  assert.deepEqual(state, {
    fanSpeed: 4,
    lightOn: true,
    afterCookingOn: true,
    carbonFilterAvailable: true,
    greaseFilterFull: true,
    carbonFilterFull: true,
    dimLevel: 80,
    periodicVenting: 15,
  });
});

test('parseTxState handles light off and rejects wrong keycode', () => {
  assert.equal(protocol.parseTxState(Buffer.from('12340-----000', 'ascii')).lightOn, false);
  assert.equal(protocol.parseTxState(Buffer.from('99994L-----100', 'ascii')), null);
  assert.equal(protocol.parseTxState(Buffer.from('1234', 'ascii')), null);
});

test('parseTxState rejects echoed commands', () => {
  ['1234Kochfeld', '1234-Dim044-', '1234-Luft-3-', '1234Luft-Aus', '1234Period30'].forEach((echo) => {
    assert.equal(protocol.parseTxState(Buffer.from(echo, 'ascii')), null, echo);
  });
});

test('command builders', () => {
  assert.equal(protocol.fanSpeedCommand(0), 'Luft-Aus');
  assert.equal(protocol.fanSpeedCommand(6), '-Luft-6-');
  assert.throws(() => protocol.fanSpeedCommand(7), RangeError);
  assert.equal(protocol.dimCommand(5), '-Dim005-');
  assert.throws(() => protocol.dimCommand(0), RangeError);
  assert.equal(protocol.periodicVentingCommand(0), 'Period00');
  assert.equal(protocol.periodicVentingCommand(30), 'Period30');
  assert.equal(protocol.afterCookingCommand('auto'), 'NachlAut');
  assert.throws(() => protocol.afterCookingCommand('x'), RangeError);
});

test('every command is 8 characters', () => {
  const commands = [
    ...Object.values(protocol.COMMANDS),
    ...Array.from({ length: 7 }, (_, i) => protocol.fanSpeedCommand(i)),
    protocol.dimCommand(100),
  ];
  commands.forEach((command) => assert.equal(command.length, 8, command));
});

test('buildPayload prefixes keycode', () => {
  assert.equal(protocol.buildPayload('Kochfeld').toString('ascii'), '1234Kochfeld');
  assert.throws(() => protocol.buildPayload('short'));
});

test('isFjaraskupanAdvertisement', () => {
  assert.equal(protocol.isFjaraskupanAdvertisement({ manufacturerData: manufacturerData() }), true);
  assert.equal(protocol.isFjaraskupanAdvertisement({ serviceUuids: ['77a2bd49-1e5a-4961-bba1-21f34fa4bc7b'] }), true);
  assert.equal(protocol.isFjaraskupanAdvertisement({ localName: 'COOKERHOOD_FJAR' }), true);
  assert.equal(protocol.isFjaraskupanAdvertisement({ address: '00:1e:c0:11:22:33', localName: 'Smart hood light' }), false);
  assert.equal(protocol.isFjaraskupanAdvertisement(null), false);
});
