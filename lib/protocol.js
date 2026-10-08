'use strict';

/**
 * Fjäråskupan BLE protocol.
 *
 * Based on https://github.com/elupus/fjaraskupan (used by Home Assistant).
 * Commands are written as `<keycode><8 char command>` to the RX characteristic.
 * State can be read from the TX characteristic or parsed from the
 * manufacturer data in the BLE advertisement.
 */

// Homey expects UUIDs in lowercase without dashes.
const SERVICE_UUID = '77a2bd491e5a4961bba121f34fa4bc7b';
const RX_CHARACTERISTIC_UUID = '23123e0a1ad643a696ac06f57995330d';
const TX_CHARACTERISTIC_UUID = '68ecc82c928d4af0aa600d578ffb35f7';

const DEFAULT_KEYCODE = '1234';
const MANUFACTURER_HEADER = 'HOODFJAR';

const FAN_SPEEDS = 6;
const MAX_DIM_LEVEL = 100;
const MAX_VENTING_PERIOD = 59;

const AFTER_COOKING_MODES = ['off', 'auto', 'manual'];

const COMMANDS = {
  STOP_FAN: 'Luft-Aus',
  LIGHT_TOGGLE: 'Kochfeld',
  AFTER_COOKING_MANUAL: 'Nachlauf',
  AFTER_COOKING_AUTO: 'NachlAut',
  AFTER_COOKING_OFF: 'NachlAus',
  RESET_GREASE_FILTER: 'ResFett-',
  RESET_CARBON_FILTER: 'ResKohle',
};

function normalizeKey(str) {
  if (!str) return '';
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}, got ${value}`);
  }
}

function fanSpeedCommand(speed) {
  assertInteger(speed, 0, FAN_SPEEDS, 'Fan speed');
  if (speed === 0) return COMMANDS.STOP_FAN;
  return `-Luft-${speed}-`;
}

function dimCommand(level) {
  assertInteger(level, 1, MAX_DIM_LEVEL, 'Dim level');
  return `-Dim${String(level).padStart(3, '0')}-`;
}

function periodicVentingCommand(minutes) {
  assertInteger(minutes, 0, MAX_VENTING_PERIOD, 'Venting period');
  return `Period${String(minutes).padStart(2, '0')}`;
}

function afterCookingCommand(mode) {
  switch (mode) {
    case 'off': return COMMANDS.AFTER_COOKING_OFF;
    case 'auto': return COMMANDS.AFTER_COOKING_AUTO;
    case 'manual': return COMMANDS.AFTER_COOKING_MANUAL;
    default: throw new RangeError(`Unknown after cooking mode: ${mode}`);
  }
}

function buildPayload(command, keycode = DEFAULT_KEYCODE) {
  if (typeof command !== 'string' || command.length !== 8) {
    throw new Error(`Command must be exactly 8 characters, got "${command}"`);
  }
  return Buffer.from(`${keycode}${command}`, 'ascii');
}

function inRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Parse manufacturer data from an advertisement.
 * Homey may deliver the data with or without the two byte company id ("HO").
 *
 * @param {Buffer} data
 * @param {object} [previous] previously known state, used to filter bogus light reports
 * @returns {object|null}
 */
function parseManufacturerData(data, previous = null) {
  if (!Buffer.isBuffer(data)) return null;

  let buf = data;
  if (buf.slice(0, 8).toString('ascii') !== MANUFACTURER_HEADER) {
    if (buf.slice(0, 6).toString('ascii') !== MANUFACTURER_HEADER.slice(2)) return null;
    buf = Buffer.concat([Buffer.from(MANUFACTURER_HEADER.slice(0, 2), 'ascii'), buf]);
  }

  if (buf.length < 12) return null;

  const state = {
    fanSpeed: buf[8],
    afterCookingFanSpeed: buf[9],
    lightOn: (buf[10] & 0x01) !== 0,
    afterCookingOn: (buf[10] & 0x02) !== 0,
    periodicVentingOn: (buf[10] & 0x04) !== 0,
    greaseFilterFull: (buf[11] & 0x01) !== 0,
    carbonFilterFull: (buf[11] & 0x02) !== 0,
    carbonFilterAvailable: (buf[11] & 0x04) !== 0,
    dimLevel: buf.length > 13 ? inRange(buf[13], 0, MAX_DIM_LEVEL) : null,
    periodicVenting: buf.length > 14 ? inRange(buf[14], 0, MAX_VENTING_PERIOD) : null,
  };

  // The hood briefly reports the light as on while dimming down to switch off.
  if (previous
    && state.lightOn
    && previous.lightOn === false
    && state.dimLevel !== null
    && typeof previous.dimLevel === 'number'
    && state.dimLevel < previous.dimLevel) {
    state.lightOn = false;
  }

  return state;
}

/**
 * Parse the state read from the TX characteristic.
 *
 * @param {Buffer} data
 * @param {string} [keycode]
 * @returns {object|null}
 */
function parseTxState(data, keycode = DEFAULT_KEYCODE) {
  if (!Buffer.isBuffer(data) || data.length < 10) return null;

  const str = data.toString('ascii');
  if (str.slice(0, 4) !== keycode) return null;

  // Reading the RX characteristic after a write returns the written command
  // (e.g. "1234-Dim044-"), which must not be mistaken for state.
  if (!/^\d$/.test(str[4])) return null;
  if (str.length >= 13 && !/^\d{3}$/.test(str.slice(10, 13))) return null;

  const fanSpeed = parseInt(str[4], 10);
  const dimLevel = parseInt(str.slice(10, 13), 10);
  const periodicVenting = parseInt(str.slice(13, 15), 10);

  return {
    fanSpeed: Number.isNaN(fanSpeed) ? null : fanSpeed,
    lightOn: str[5] === 'L',
    afterCookingOn: str[6] === 'N',
    carbonFilterAvailable: str[7] === 'C',
    greaseFilterFull: str[8] === 'F',
    carbonFilterFull: str[9] === 'K',
    dimLevel: inRange(dimLevel, 0, MAX_DIM_LEVEL),
    periodicVenting: inRange(periodicVenting, 0, MAX_VENTING_PERIOD),
  };
}

function isFjaraskupanAdvertisement(advertisement) {
  if (!advertisement) return false;

  if (Buffer.isBuffer(advertisement.manufacturerData)
    && advertisement.manufacturerData.toString('ascii').includes(MANUFACTURER_HEADER.slice(2))) {
    return true;
  }

  const services = advertisement.serviceUuids || advertisement.services || [];
  if (services.some((uuid) => normalizeKey(uuid) === SERVICE_UUID)) return true;

  const localName = (advertisement.localName || advertisement.name || '').toUpperCase();
  return localName.includes('FJAR') || localName.includes('COOKERHOOD');
}

module.exports = {
  SERVICE_UUID,
  RX_CHARACTERISTIC_UUID,
  TX_CHARACTERISTIC_UUID,
  DEFAULT_KEYCODE,
  FAN_SPEEDS,
  MAX_DIM_LEVEL,
  MAX_VENTING_PERIOD,
  AFTER_COOKING_MODES,
  COMMANDS,
  normalizeKey,
  fanSpeedCommand,
  dimCommand,
  periodicVentingCommand,
  afterCookingCommand,
  buildPayload,
  parseManufacturerData,
  parseTxState,
  isFjaraskupanAdvertisement,
};
