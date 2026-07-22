browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DOWNLOAD_ZIP') {
    handleDownloadZip(message, sender, sendResponse);
    return true;
  }

  if (message.type === 'FETCH_IMAGE') {
    handleFetchImage(message, sender, sendResponse);
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    browser.storage.sync.get('settings', (data) => {
      sendResponse(data.settings || getDefaultSettings());
    });
    return true;
  }

  if (message.type === 'SAVE_SETTINGS') {
    browser.storage.sync.set({ settings: message.settings }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

function getDefaultSettings() {
  return {
    numberImages: false,
    numberSeparator: ': ',
    maxThreads: 3,
    retryCount: 3,
    delayBetweenImages: 800,
    saveAsCbz: false,
    autoStart: false,
    replaceDangerChars: true,
    savePageLinks: true,
    smartThrottle: true,
    maxDelay: 15000,
    banPauseMinutes: 5,
    downloadOriginal: false,
  };
}

async function handleDownloadZip(message, sender, sendResponse) {
  try {
    const { zipBase64, fileName } = message;
    const ext = message.saveAsCbz ? '.cbz' : '.zip';

    const result = await browser.downloads.download({
      url: 'data:application/zip;base64,' + zipBase64,
      filename: fileName + ext,
      saveAs: true
    });

    sendResponse({ ok: true, downloadId: result });
  } catch (err) {
    console.error('[EHD] Download error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

async function handleFetchImage(message, sender, sendResponse) {
  try {
    const { url, index, pageURL } = message;
    const response = await fetch(url, {
      referrer: pageURL || 'https://e-hentai.org/',
      referrerPolicy: 'unsafe-url',
      headers: {
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    let ext = '.jpg';
    if (contentType.includes('png')) ext = '.png';
    else if (contentType.includes('webp')) ext = '.webp';
    else if (contentType.includes('gif')) ext = '.gif';

    const buffer = await response.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    sendResponse({ ok: true, base64, ext, index });
  } catch (err) {
    sendResponse({ ok: false, error: err.message, index: message.index });
  }
  return true;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}
