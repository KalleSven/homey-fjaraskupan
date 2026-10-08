'use strict';

const { Driver } = require('homey');
const {
  SERVICE_UUID,
  normalizeKey,
  isFjaraskupanAdvertisement,
} = require('../../lib/protocol');

const DISCOVER_TIMEOUT = 10 * 1000;

function advertisementKeys(advertisement) {
  return [advertisement.uuid, advertisement.address, advertisement.id]
    .map(normalizeKey)
    .filter(Boolean);
}

class FjaraskupanDriver extends Driver {

  static DISCOVER_INTERVAL = 1000 * 30;

  async onInit() {
    this.advertisements = new Map();
    this._discoverPromise = null;
    this.setMaxListeners(50);

    this._registerFlowCards();

    this.onDiscover = this.onDiscover.bind(this);
    this.onDiscoverInterval = this.homey.setInterval(this.onDiscover, this.constructor.DISCOVER_INTERVAL);
    await this.onDiscover();
    this.log('Fjäråskupan Driver has been initialized');
  }

  async onUninit() {
    if (this.onDiscoverInterval) {
      this.homey.clearInterval(this.onDiscoverInterval);
    }
  }

  _registerFlowCards() {
    const action = (id, fn) => this.homey.flow.getActionCard(id).registerRunListener(fn);
    const condition = (id, fn) => this.homey.flow.getConditionCard(id).registerRunListener(fn);

    action('light_on', ({ device }) => device.setLight(true));
    action('light_off', ({ device }) => device.setLight(false));
    action('set_light_dim', ({ device, level }) => device.setDimLevel(Math.round(level * 100)));
    action('set_fan_speed', ({ device, speed }) => device.setFanSpeed(Number(speed)));
    action('turn_off_all', ({ device }) => device.turnOffAll());
    action('set_after_cooking', ({ device, mode }) => device.setAfterCooking(mode));
    action('venting_on', ({ device }) => device.setVenting(true));
    action('venting_off', ({ device }) => device.setVenting(false));
    action('reset_grease_filter', ({ device }) => device.resetGreaseFilter());
    action('reset_carbon_filter', ({ device }) => device.resetCarbonFilter());

    condition('light_is_on', ({ device }) => device.getCapabilityValue('onoff.light') === true);
    condition('fan_is_running', ({ device }) => Number(device.getCapabilityValue('fan_speed')) > 0);

    this.triggers = {
      lightTurnedOn: this.homey.flow.getDeviceTriggerCard('light_turned_on'),
      lightTurnedOff: this.homey.flow.getDeviceTriggerCard('light_turned_off'),
      fanSpeedChanged: this.homey.flow.getDeviceTriggerCard('fan_speed_changed'),
      greaseFilterFull: this.homey.flow.getDeviceTriggerCard('grease_filter_full'),
      carbonFilterFull: this.homey.flow.getDeviceTriggerCard('carbon_filter_full'),
    };
  }

  /**
   * Scan for advertisements. Concurrent callers share the same scan,
   * since Homey does not allow parallel BLE discoveries.
   */
  onDiscover() {
    if (!this._discoverPromise) {
      this._discoverPromise = this._discover().finally(() => {
        this._discoverPromise = null;
      });
    }
    return this._discoverPromise;
  }

  async _discover(serviceFilter = []) {
    const advertisements = await this.homey.ble.discover(serviceFilter, DISCOVER_TIMEOUT).catch((err) => {
      this.error('BLE discovery error:', err.message || err);
      return [];
    });

    if (!Array.isArray(advertisements)) return [];

    const hoods = advertisements.filter(isFjaraskupanAdvertisement);
    if (hoods.length !== this._lastHoodCount) {
      this._lastHoodCount = hoods.length;
      this.log(`Discovery: ${advertisements.length} BLE device(s), ${hoods.length} hood(s)`);
    }
    hoods.forEach((advertisement) => this._handleAdvertisement(advertisement));
    return hoods;
  }

  _handleAdvertisement(advertisement) {
    advertisementKeys(advertisement).forEach((key) => this.advertisements.set(key, advertisement));
    this.emit('advertisement', advertisement);
  }

  async onPairListDevices() {
    this.log('Pairing: releasing active connections...');
    await Promise.all(this.getDevices().map((device) => device.releaseConnection().catch(this.error)));

    this.log('Pairing: scanning BLE for Fjäråskupan devices...');
    let hoods = await this.onDiscover();

    if (hoods.length === 0) {
      this.log('Pairing: no hood found in passive scan, scanning with service filter...');
      hoods = await this._discover([SERVICE_UUID]);
    }

    const unique = new Map();
    hoods.forEach((advertisement) => unique.set(advertisement.uuid || advertisement.address, advertisement));
    this.log(`Pairing: found ${unique.size} Fjäråskupan device(s).`);

    return Array.from(unique.values()).map((advertisement) => {
      const localName = advertisement.localName || '';
      const isNamedHood = /FJAR|COOKERHOOD/i.test(localName);
      const displayName = isNamedHood ? localName : this.homey.__('pair.default_name');
      const id = advertisement.uuid || advertisement.address;

      return {
        name: `${displayName} (${advertisement.address || id})`,
        data: {
          id,
          address: advertisement.address || id,
          uuid: advertisement.uuid || id,
        },
      };
    });
  }

  matches(advertisement, data) {
    const keys = advertisementKeys(advertisement);
    return [data.uuid, data.address, data.id].map(normalizeKey).some((key) => key && keys.includes(key));
  }

  clearCachedAdvertisement(data) {
    [data.uuid, data.address, data.id].map(normalizeKey).forEach((key) => this.advertisements.delete(key));
  }

  async getAdvertisement(data, forceRefresh = false) {
    const keys = [data.uuid, data.address, data.id].map(normalizeKey).filter(Boolean);
    if (keys.length === 0) throw new Error('No device identifier provided');

    if (!forceRefresh) {
      const cachedKey = keys.find((key) => this.advertisements.has(key));
      if (cachedKey) return this.advertisements.get(cachedKey);
    }

    // ble.find() takes Homey's peripheral UUID, not the MAC address.
    if (data.uuid) {
      try {
        this.log(`Searching directly for BLE peripheral ${data.uuid}...`);
        const advertisement = await this.homey.ble.find(data.uuid, 4000);
        if (advertisement) {
          advertisementKeys(advertisement).forEach((key) => this.advertisements.set(key, advertisement));
          return advertisement;
        }
      } catch (err) {
        this.log(`Direct find for ${data.uuid} failed (${err.message}), waiting for advertisement...`);
      }
    }

    return new Promise((resolve, reject) => {
      let timer = null;

      const onAdvertisement = (advertisement) => {
        if (!this.matches(advertisement, data)) return;
        this.homey.clearTimeout(timer);
        this.removeListener('advertisement', onAdvertisement);
        resolve(advertisement);
      };

      timer = this.homey.setTimeout(() => {
        this.removeListener('advertisement', onAdvertisement);
        reject(new Error(this.homey.__('error.device_not_found')));
      }, DISCOVER_TIMEOUT + 2000);

      this.on('advertisement', onAdvertisement);
      this.onDiscover().catch(this.error);
    });
  }

}

module.exports = FjaraskupanDriver;
