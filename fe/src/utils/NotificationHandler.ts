import loggerFactory from '@/utils/loggerFactory';
import {Logger} from 'lines-logger';
import {extractError} from '@/utils/utils';
import Api from '@/utils/api';
import WsHandler from '@/utils/WsHandler';
import {DefaultStore} from '@/utils/store';
import {IS_DEBUG, MANIFEST, SERVICE_WORKER_URL} from '@/utils/consts';
import {forEach} from '@/utils/htmlApi';

const LAST_TAB_ID_VARNAME = 'lastTabId';

export default class NotifierHandler {
  private logger: Logger;
  private currentTabId: string;
  private popedNotifQueue: Notification[] = [];
  /*This is required to know if this tab is the only one and don't spam with same notification for each tab*/
  private serviceWorkedTried = false;
  private serviceWorkerRegistration: any = null;
  private subscriptionId: string|null = null;
  private isCurrentTabActive: boolean = false;
  private newMessagesCount: number = 0;
  private unloaded: boolean = false;
  private store: DefaultStore;
  private readonly api: Api;
  private readonly browserVersion: string;
  private readonly isChrome: boolean;
  private readonly isMobile: boolean;
  private readonly ws: WsHandler;

  constructor(api: Api, browserVersion: string, isChrome: boolean, isMobile: boolean, ws: WsHandler, store: DefaultStore) {
    this.api = api;
    this.browserVersion = browserVersion;
    this.isChrome = isChrome;
    this.isMobile = isMobile;
    this.ws = ws;
    this.store = store;
    this.logger = loggerFactory.getLoggerColor('notify', '#e39800');
    this.currentTabId = Date.now().toString();
    window.addEventListener('blur', this.onFocusOut.bind(this));
    window.addEventListener('focus', this.onFocus.bind(this));
    window.addEventListener('beforeunload', this.onUnload.bind(this));
    window.addEventListener('unload', this.onUnload.bind(this));
    this.onFocus(null);

  }

  replaceIfMultiple(data: {title: string, options: NotificationOptions}) {
    let count = 1;
    let newMessData = data.options.data;
    if (newMessData && newMessData.replaced) {
      this.popedNotifQueue.forEach((e: Notification) => {
        if (e.data && e.data.title === newMessData.title || e.title === newMessData.title) {
          count += e.replaced || e.data.replaced;
          e.close();
        }
      });
      if (count > 1) {
        newMessData.replaced = count;
        data.title = newMessData.title + '(+' + count + ')';
      }
    }
  }

// Permissions are granted here!
  private async showNot(title: string, options: NotificationOptions) {
    this.logger.debug('Showing notification {} {}', title, options);
    if (this.serviceWorkerRegistration && this.isMobile && this.isChrome) {
      // TODO  options should contain page id here but it's not
      // so we open unfefined url
      let r = await this.serviceWorkerRegistration.showNotification(title, options);
      this.logger.debug('res {}', r)(); // TODO https://stackoverflow.com/questions/39717947/service-worker-notification-promise-broken#comment83407282_39717947
    } else {
      let data = {title, options};
      this.replaceIfMultiple(data);
      let not = new Notification(data.title, data.options);
      if (data.options.replaced) {
        not.replaced = data.options.replaced;
      }
      this.popedNotifQueue.push(not);
      not.onclick = () => {
        window.focus();
        if (not.data && not.data.roomId) {
          this.store.setActiveRoomId(parseInt(not.data.roomId));
        }
        not.close();
      };
      not.onclose = () => {
        this.popedNotifQueue.splice(this.popedNotifQueue.indexOf(not), 1);
      };
      this.logger.debug('Notification {} {} has been spawned, current queue {}', title, options, this.popedNotifQueue)();
    }
  }

  /**
   * @return true if Permissions were asked and user granted them
   * */
  async checkPermissions() {
    if ((<any>Notification).permission !== 'granted') { // TODO
      let result = await Notification.requestPermission();
      if (result !== 'granted') {
        throw Error(`User blocked notification permission. Notifications won't be available`);
      }
      return true;
    }
    return false;
  }


  private async registerWorker() {
    if (!navigator.serviceWorker) {
      throw Error('Service worker is not supported');
    } else if (!MANIFEST || ! SERVICE_WORKER_URL) {
     throw Error('FIREBASE_API_KEY is missing in settings.py or file chat/static/manifest.json is missing');
    }
    let r = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {scope: '/'});
    this.logger.debug('Registered service worker {}', r)();
    this.serviceWorkerRegistration = await navigator.serviceWorker.ready;
    this.logger.debug('Service worker is ready {}', this.serviceWorkerRegistration)();
    let subscription = await this.serviceWorkerRegistration.pushManager.subscribe({userVisibleOnly: true});
    this.logger.debug('Got subscription {}', subscription)();
    this.subscriptionId = subscription.toJSON();
    if (!this.subscriptionId) {
      throw Error('Current browser doesnt support offline notifications');
    }

    await this.api.registerFCB(this.subscriptionId, this.browserVersion, this.isMobile);
    this.logger.log('Saved subscription to server')();

  }


  async tryAgainRegisterServiceWorker() {
    try {
      if (!(<any>window).Notification) {
        throw Error('Notifications are not supported');
      }
      let granted = await this.checkPermissions();
      if (granted) {
        await this.showNot('Pychat notifications enabled', {
          body: 'You can disable them in room\'s settings',
          replaced: 1,
        });
      }
      if (!this.serviceWorkedTried) {
        await this.registerWorker();
      }
    } catch (e) {
      this.logger.error('Error registering service worker {}', extractError(e))();
    } finally {
      this.serviceWorkedTried = true;
    }
  }

  async showNotification(title: string, options: NotificationOptions) {
    if (this.isCurrentTabActive) {
      return;
    }
    this.newMessagesCount++;
    document.title = this.newMessagesCount + ' new messages';
    try {
      navigator.vibrate(200);
    } catch (e) {
      this.logger.debug('Vibration skipped, because ', e);
    }
    // last opened tab not this one, leave the oppotunity to show notification from last tab
    if (!(<any>window).Notification
        || !this.isTabMain()) {
      return;
    }
    await this.checkPermissions();
    await this.showNot(title, options);
  }

  isTabMain() {
    let activeTab = localStorage.getItem(LAST_TAB_ID_VARNAME);
    if (activeTab === '0') {
      localStorage.setItem(LAST_TAB_ID_VARNAME, this.currentTabId);
      activeTab = this.currentTabId;
    }
    return activeTab === this.currentTabId;
  }

  onUnload() {
    if (this.unloaded) {
      return;
    }
    if (this.isTabMain()) {
      localStorage.setItem(LAST_TAB_ID_VARNAME, '0');
    }
    this.unloaded = true;
  }

  onFocus(e: Event|null) {
    localStorage.setItem(LAST_TAB_ID_VARNAME, this.currentTabId);
    if (e) {
      this.logger.trace('Marking current tab as active, pinging server')();
      if (this.store.userInfo && this.ws.isWsOpen() && !IS_DEBUG) {
        this.ws.pingServer(); // if no event = call from init();
      }
    } else {
      this.logger.trace('Marking current tab as active')();
    }
    this.isCurrentTabActive = true;
    this.newMessagesCount = 0;
    document.title = 'PyChat';
    this.popedNotifQueue.forEach( (n) => {
      n.close();
    });
  }

  onFocusOut() {
    this.isCurrentTabActive = false;
    this.logger.trace('Deactivating current tab')();
  }
}
