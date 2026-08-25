function resumableAccountUrl(accountUrl, candidate) {
  if (!candidate) return null;
  try {
    const account = new URL(accountUrl);
    const target = new URL(candidate);
    if (!/^https?:$/.test(target.protocol) || target.origin !== account.origin)
      return null;
    return target.toString();
  } catch {
    return null;
  }
}

module.exports = { resumableAccountUrl };
