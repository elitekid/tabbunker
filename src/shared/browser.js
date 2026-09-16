// globalThis.browser ?? chrome 래퍼(프로미스)

const api = globalThis.browser ?? globalThis.chrome;

/**
 * chrome.* 콜백 API를 Promise로 변환
 */
export function promisify(fn, context = api) {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn.call(context, ...args, (result) => {
        const err = api.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    });
}

/** 콜백 또는 프로미스 반환 API 통합 */
export function callOrPromise(fn, context, ...args) {
  const ret = fn.call(context, ...args);
  if (ret && typeof ret.then === 'function') return ret;
  return new Promise((resolve, reject) => {
    const err = api.runtime?.lastError;
    if (err) reject(new Error(err.message));
    else resolve(ret);
  });
}

function promisifyContextMenuCreate(createFn, context) {
  return (props) =>
    new Promise((resolve, reject) => {
      try {
        const ret = createFn.call(context, props, () => {
          const err = api.runtime?.lastError;
          if (err) reject(new Error(err.message));
          else resolve(ret);
        });
        if (typeof ret === 'string' && !api.runtime?.lastError) {
          /* Firefox: id 동기 반환, 콜백은 완료 시 */
        }
      } catch (e) {
        reject(e);
      }
    });
}

export const browserApi = api;

export const tabs = {
  query: promisify(api.tabs.query, api.tabs),
  create: promisify(api.tabs.create, api.tabs),
  remove: promisify(api.tabs.remove, api.tabs),
  get: promisify(api.tabs.get, api.tabs),
  update: promisify(api.tabs.update, api.tabs),
  move: promisify(api.tabs.move, api.tabs),
};

export const windows = {
  get: promisify(api.windows.get, api.windows),
  getLastFocused: promisify(api.windows.getLastFocused, api.windows),
};

export const storage = {
  local: {
    get: promisify(api.storage.local.get, api.storage.local),
    set: promisify(api.storage.local.set, api.storage.local),
    remove: promisify(api.storage.local.remove, api.storage.local),
  },
};

export const downloads = {
  download: promisify(api.downloads.download, api.downloads),
  search: promisify(api.downloads.search, api.downloads),
  removeFile: promisify(api.downloads.removeFile, api.downloads),
  erase: promisify(api.downloads.erase, api.downloads),
  cancel: promisify(api.downloads.cancel, api.downloads),
};

export const alarms = {
  create: promisify(api.alarms.create, api.alarms),
  clear: promisify(api.alarms.clear, api.alarms),
  get: promisify(api.alarms.get, api.alarms),
  getAll: promisify(api.alarms.getAll, api.alarms),
};

export const commands = {
  getAll: promisify(api.commands.getAll, api.commands),
};

export const action = api.action ?? api.browserAction;

const ctxMenus = api.contextMenus ?? api.menus;

export const contextMenus = ctxMenus
  ? {
      removeAll: promisify(ctxMenus.removeAll, ctxMenus),
      create: promisifyContextMenuCreate(ctxMenus.create, ctxMenus),
      onClicked: ctxMenus.onClicked,
    }
  : null;

export const actionBadge = {
  setBadgeText: (opts) => callOrPromise(action.setBadgeText, action, opts),
  setBadgeBackgroundColor: (opts) =>
    callOrPromise(action.setBadgeBackgroundColor, action, opts),
};
