/**
 * Convert API/Axios errors into readable UI messages.
 */

export function getApiErrorMessage(error: any, fallback = 'Bir hata olustu.'): string {
  const data = error?.response?.data;
  if (!data) {
    return fallback;
  }

  if (typeof data === 'string') {
    return data;
  }

  if (typeof data?.detail === 'string') {
    return data.detail;
  }

  if (Array.isArray(data?.detail)) {
    const lines = data.detail
      .map((item: any) => {
        const loc = Array.isArray(item?.loc) ? item.loc.filter((x: any) => x !== 'body').join('.') : '';
        const fieldLabel = loc ? `${loc}: ` : '';
        const msg = item?.msg || 'Gecersiz deger';
        return `${fieldLabel}${msg}`;
      })
      .filter(Boolean);

    if (lines.length > 0) {
      return lines.join('\n');
    }
  }

  if (typeof data?.detail === 'object' && data?.detail !== null) {
    return JSON.stringify(data.detail);
  }

  return fallback;
}
