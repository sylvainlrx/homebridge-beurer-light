'use strict';

const convert = require('color-convert');
const noble = require('@abandonware/noble');

const PLUGIN_NAME = 'homebridge-beurer-light';
const PLATFORM_NAME = 'BeurerLight';

const SERVICE_UUID = '7087';
const LAMP_CONTROL_UUID = '8b00ace7eb0b49b0bbe99aee0a26e1a3';
const NOTIFY_UUID = '0734594aa8e74b1aa6b1cd5243059a57';

let Accessory, Service, Characteristic, UUIDGen;

module.exports = (api) => {
  Accessory = api.platformAccessory;
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, BeurerPlatform);
};

class BeurerPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();

    this.api.on('didFinishLaunching', () => {
      this.log.info('Finished launching, starting BLE scan...');
      this.startScanning();
    });
  }

  configureAccessory(accessory) {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    const light = new BeurerLight(accessory, this);
    this.accessories.set(accessory.UUID, light);
  }

  startScanning() {
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        this.log.info('Bluetooth powered on, scanning for Beurer lights...');
        noble.startScanning([SERVICE_UUID], true, (error) => {
          if (error) {
            this.log.error('Could not start scanning:', error);
          }
        });
      } else {
        this.log.warn('Bluetooth state:', state);
      }
    });

    noble.on('discover', (peripheral) => {
      this.handleDiscoveredPeripheral(peripheral);
    });
  }

  handleDiscoveredPeripheral(peripheral) {
    noble.stopScanning();
    this.log.info('Found device:', peripheral.advertisement.localName || peripheral.uuid);

    const uuid = UUIDGen.generate(peripheral.uuid);
    const existingLight = this.accessories.get(uuid);

    if (existingLight) {
      this.log.info('Linking existing accessory with peripheral');
      existingLight.setPeripheral(peripheral);
      return;
    }

    const accessory = new Accessory(
      peripheral.advertisement.localName || 'SAD Lamp',
      uuid
    );

    accessory.context.peripheralUuid = peripheral.uuid;

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Beurer')
      .setCharacteristic(Characteristic.Model, 'TL100')
      .setCharacteristic(Characteristic.SerialNumber, peripheral.uuid);

    accessory.addService(Service.Lightbulb);

    const lightService = accessory.getService(Service.Lightbulb);
    lightService.getCharacteristic(Characteristic.On);
    lightService.getCharacteristic(Characteristic.Brightness);
    lightService.getCharacteristic(Characteristic.Hue);
    lightService.getCharacteristic(Characteristic.Saturation);

    const light = new BeurerLight(accessory, this);
    light.setPeripheral(peripheral);

    this.accessories.set(uuid, light);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.log.info('Registered new accessory:', accessory.displayName);
  }
}

class BeurerLight {
  constructor(accessory, platform) {
    this.accessory = accessory;
    this.platform = platform;
    this.log = platform.log;

    this.peripheral = null;
    this.lampControl = null;
    this.connected = false;
    this.connectionTimeout = 5000;
    this.connectionTimeoutToken = null;

    this.hue = 0;
    this.saturation = 0;
    this.brightness = 50;
    this.whiteBrightness = 50;
    this.colorBrightness = 50;
    this.whiteOn = false;
    this.colorOn = false;
    this.whichLampToControl = 1;

    this.setupCharacteristics();
  }

  setupCharacteristics() {
    const lightService = this.accessory.getService(Service.Lightbulb);
    if (!lightService) return;

    lightService
      .getCharacteristic(Characteristic.On)
      .onGet(this.isLampOn.bind(this))
      .onSet(this.setLampOn.bind(this));

    lightService
      .getCharacteristic(Characteristic.Brightness)
      .onGet(this.getBrightness.bind(this))
      .onSet(this.setBrightness.bind(this));

    lightService
      .getCharacteristic(Characteristic.Hue)
      .onGet(this.getHue.bind(this))
      .onSet(this.setHue.bind(this));

    lightService
      .getCharacteristic(Characteristic.Saturation)
      .onGet(this.getSaturation.bind(this))
      .onSet(this.setSaturation.bind(this));
  }

  setPeripheral(peripheral) {
    this.peripheral = peripheral;
    this.connect();
  }

  async connect() {
    if (!this.peripheral) {
      this.log.warn('No peripheral set, cannot connect');
      return;
    }

    this.log.info('Connecting to lamp...');

    return new Promise((resolve, reject) => {
      this.peripheral.connect((error) => {
        if (error) {
          this.log.error('Error connecting to lamp:', error);
          reject(error);
          return;
        }

        this.log.info('Successfully connected to lamp');
        this.connected = true;

        this.peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
          if (error) {
            this.log.error('Error discovering characteristics:', error);
            reject(error);
            return;
          }

          this.lampControl = characteristics.find((c) => c.uuid === LAMP_CONTROL_UUID);
          const notify = characteristics.find((c) => c.uuid === NOTIFY_UUID);

          if (!this.lampControl || !notify) {
            this.log.error('Could not find required characteristics');
            reject(new Error('Missing characteristics'));
            return;
          }

          notify.on('data', (data) => this.handleNotification(data));
          notify.subscribe();
          notify.notify(true);

          notify.once('notify', () => {
            this.log.debug('Notification characteristic ready, requesting state...');
            this.requestState();
            resolve();
          });
        });
      });
    });
  }

  requestState() {
    const whiteStatusCmd = Buffer.from([254, 239, 10, 9, 171, 170, 4, 48, 1, 53, 85, 13, 10]);
    const colorStatusCmd = Buffer.from([254, 239, 10, 9, 171, 170, 4, 48, 2, 54, 85, 13, 10]);

    this.lampControl.write(whiteStatusCmd, true, (error) => {
      if (error) this.log.error('Error requesting white state:', error);
    });

    this.lampControl.write(colorStatusCmd, true, (error) => {
      if (error) this.log.error('Error requesting color state:', error);
    });
  }

  handleNotification(data) {
    this.log.debug('Received notification:', data);

    if (data[8] === 2) {
      const red = data[13];
      const green = data[14];
      const blue = data[15];
      const hsl = convert.rgb.hsl(red, green, blue);

      this.colorBrightness = data[10];
      this.colorOn = data[9] === 1;

      if (hsl) {
        this.hue = hsl[0];
        this.saturation = hsl[1];
      }
    } else {
      this.whiteBrightness = data[10];
      this.whiteOn = data[9] === 1;
    }

    this.updateHomeKitState();
    this.resetConnectionTimeout();
  }

  updateHomeKitState() {
    const lightService = this.accessory.getService(Service.Lightbulb);
    if (!lightService) return;

    lightService
      .getCharacteristic(Characteristic.On)
      .updateValue(this.whiteOn || this.colorOn);

    lightService
      .getCharacteristic(Characteristic.Brightness)
      .updateValue(this.whiteOn ? this.whiteBrightness : this.colorBrightness);

    lightService
      .getCharacteristic(Characteristic.Hue)
      .updateValue(this.hue);

    lightService
      .getCharacteristic(Characteristic.Saturation)
      .updateValue(this.saturation);
  }

  resetConnectionTimeout() {
    if (this.connectionTimeoutToken) {
      clearTimeout(this.connectionTimeoutToken);
    }
    this.connectionTimeoutToken = setTimeout(() => this.disconnect(), this.connectionTimeout);
  }

  disconnect() {
    if (this.peripheral && this.connected) {
      this.log.info('Disconnecting from lamp');
      this.peripheral.disconnect();
      this.connected = false;
    }
  }

  getBytes(input) {
    const inputBytes = [...input];
    inputBytes[0] = input.length - 1;
    inputBytes[inputBytes.length - 2] = this.checkCode(0, inputBytes.length - 2, inputBytes);

    const bytes = [254, 239, 10, input.length + 8 - 4, 171, 170];
    bytes.push(...inputBytes);
    bytes.push(13, 10);

    return bytes;
  }

  checkCode(start, finish, bytes) {
    let b = 0;
    for (let i = start; i < (finish - start); i++) {
      b = bytes[start + i] ^ b;
    }
    return b;
  }

  async send(bytes) {
    if (!this.connected || !this.lampControl) {
      this.log.debug('Not connected, reconnecting...');
      await this.connect();
    }

    this.resetConnectionTimeout();

    const buffer = Buffer.from(this.getBytes(bytes));
    this.log.debug('Sending:', buffer);

    return new Promise((resolve, reject) => {
      this.lampControl.write(buffer, true, (error) => {
        if (error) {
          this.log.error('Error sending command:', error);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  isLampOn() {
    return this.whiteOn || this.colorOn;
  }

  async setLampOn(value) {
    if (value && this.colorOn) {
      this.log.debug('Lamp already on in color mode');
      return;
    }

    this.whichLampToControl = 1;
    if (!value && this.colorOn) {
      this.whichLampToControl = 2;
    }

    if (value) {
      this.whiteOn = true;
      this.colorOn = false;
    } else {
      this.whiteOn = false;
      this.colorOn = false;
    }

    const onOffBit = value ? 55 : 53;
    await this.send([0, onOffBit, this.whichLampToControl, 0, 85]);
  }

  getBrightness() {
    return this.colorOn ? this.colorBrightness : this.whiteBrightness;
  }

  async setBrightness(value) {
    if (this.colorOn) {
      this.colorBrightness = value;
      this.whichLampToControl = 2;
    } else {
      this.whiteBrightness = value;
      this.whichLampToControl = 1;
    }

    this.log.debug('Setting brightness:', this.whichLampToControl, value);
    await this.send([0, 49, this.whichLampToControl, value, 0, 85]);
  }

  getHue() {
    return this.hue;
  }

  async setHue(value) {
    this.hue = value;
    await this.setRgb();
  }

  getSaturation() {
    return this.saturation;
  }

  async setSaturation(value) {
    this.saturation = value;
    await this.setRgb();
  }

  async setRgb() {
    if (!this.colorOn) {
      await this.send([4, 55, 2, 0, 85]);
      this.colorOn = true;
    }

    this.colorOn = true;
    this.whiteOn = false;

    const rgb = convert.hsl.rgb(this.hue, this.saturation, 50);
    await this.send([0, 50, rgb[0], rgb[1], rgb[2], 0, 85]);
  }
}
