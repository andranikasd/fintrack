/** Optional suffix shared by commands and channel rows: source @ Account [passive]. */
export function accountEntry(raw:string) {
  const passive=/\s+\[passive\]$/i.test(raw);
  const text=raw.replace(/\s+\[passive\]$/i,'').trim();
  const at=text.lastIndexOf(' @ ');
  return {label:(at<0?text:text.slice(0,at)).trim(),accountName:at<0?null:text.slice(at+3).trim(),passive};
}
