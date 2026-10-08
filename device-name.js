// Понятное имя устройства по строке браузера: «iPhone · Safari», «Windows · Chrome» и т. п.
// Используется при подключении по QR-коду и в списке «Мои устройства».
export function describeUserAgent(ua) {
  ua = String(ua || "");
  if (!ua) return "Неизвестное устройство";
  let device = "Компьютер";
  if (/iPhone/.test(ua)) device = "iPhone";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) device = "iPad";
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? "Android-телефон" : "Android-планшет";
  else if (/Windows/.test(ua)) device = "Windows";
  else if (/Macintosh|Mac OS X/.test(ua)) device = "Mac";
  else if (/Linux/.test(ua)) device = "Linux";

  let browser = "";
  if (/YaBrowser\//.test(ua)) browser = "Яндекс Браузер";
  else if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Firefox\/|FxiOS/.test(ua)) browser = "Firefox";
  else if (/Chrome\/|CriOS/.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return browser ? `${device} · ${browser}` : device;
}
