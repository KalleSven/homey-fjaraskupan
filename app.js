'use strict';

const Homey = require('homey');

class FjaraskupanApp extends Homey.App {

  async onInit() {
    this.log('Fjäråskupan App has been initialized');
  }

}

module.exports = FjaraskupanApp;
