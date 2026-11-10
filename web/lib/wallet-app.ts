/// Getting a phone into a wallet.
///
/// There is no injected provider in Safari or Chrome on a phone: the wallet is a separate app. Every
/// mobile wallet ships an in-app browser, and a universal link opens it on the current page, where the
/// wallet does inject one. That is the whole mechanism, and it needs no relay, no project id and no
/// dependency.
///
/// WalletConnect would add a second path — pair in place, without leaving the browser — but it pulls a
/// dependency tree with open advisories into the bundle, so the app takes the path that costs nothing
/// to trust.

export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  /// iPadOS 13 and later report as a desktop Macintosh; the touch point is what gives it away.
  const iPadPretendingToBeMac = /Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadPretendingToBeMac;
}

export type WalletAppLink = { id: string; label: string; href: string };

/// The link formats each wallet documents for opening a dapp in its own browser.
export function walletAppLinks(pageUrl: string): WalletAppLink[] {
  const withoutScheme = pageUrl.replace(/^https?:\/\//, "");
  return [
    { id: "metamask", label: "metamask", href: `https://metamask.app.link/dapp/${withoutScheme}` },
    { id: "okx", label: "okx wallet", href: `https://www.okx.com/web3/dapp-browser?url=${encodeURIComponent(pageUrl)}` },
    { id: "phantom", label: "phantom", href: `https://phantom.app/ul/browse?url=${encodeURIComponent(pageUrl)}` },
  ];
}
