/**
 * /phone: how to make a phone a first-class ClipSync device.
 *
 * Android installs the app and gets ClipSync in its share sheet. iOS Safari
 * has no share target for web apps, so an iPhone sends through the paste dock,
 * the Attach button, or a Shortcut that opens `/share#text=…`. The Shortcut
 * carries no token and never calls the API: Shortcuts has no AES-GCM, so it
 * hands the text to this page, which encrypts it on the phone.
 */

import { useState } from "react";

/**
 * A ready-made Shortcut, shared from the Shortcuts app as an iCloud link
 * (https://www.icloud.com/shortcuts/…). Empty: the page shows how to build
 * it instead. It must open this deployment's own /share.
 */
const SHORTCUT_URL = "";

export function PhoneSetup({ onClose }: { onClose: () => void }) {
  const shareUrl = `${window.location.origin}/share#text=`;
  const [copied, setCopied] = useState(false);

  return (
    <article className="card setup">
      <h1>Set up your phone</h1>
      <p className="muted">
        Pair the phone first (scan the QR from <code>clipsync invite</code>),
        then:
      </p>

      <h2>Android</h2>
      <ol>
        <li>
          In Chrome, open the menu and choose <b>Add to Home screen</b> (or{" "}
          <b>Install app</b>).
        </li>
        <li>
          To send, use <b>Share → ClipSync</b> from any app: text, links,
          photos and files. They are encrypted on the phone before they leave
          it.
        </li>
        <li>
          Or open ClipSync after copying something and tap{" "}
          <b>Paste to ClipSync</b>.
        </li>
        <li>
          To receive, open ClipSync and tap <b>Copy</b> on the card at the top.
        </li>
      </ol>

      <h2>iPhone and iPad</h2>
      <ol>
        <li>
          In Safari, tap <b>Share → Add to Home Screen</b>.
        </li>
        <li>
          To send, open ClipSync after copying something and tap{" "}
          <b>Paste to ClipSync</b> (text or an image), or <b>Attach</b> a photo
          or file. iOS asks you to confirm each paste.
        </li>
        <li>
          To receive, open ClipSync and tap <b>Copy</b> on the card at the top.
        </li>
      </ol>

      <h3>Send from anywhere with a Shortcut</h3>
      {SHORTCUT_URL ? (
        <p>
          <a className="button" href={SHORTCUT_URL}>
            Get the “Send to ClipSync” Shortcut
          </a>
        </p>
      ) : (
        <ol>
          <li>
            In the Shortcuts app, tap <b>+</b> and name it{" "}
            <b>Send to ClipSync</b>.
          </li>
          <li>
            Add <b>Get Clipboard</b>, then <b>URL Encode</b>.
          </li>
          <li>
            Add <b>Text</b> containing this address, followed by the{" "}
            <i>URL Encoded Text</i> variable:
            <div className="copyrow">
              <code>{shareUrl}</code>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(shareUrl).then(() => setCopied(true))
                }
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </li>
          <li>
            Add <b>Open URLs</b>.
          </li>
        </ol>
      )}
      <p className="muted small">
        The Shortcut sends text only. It opens Safari, which keeps its own
        storage apart from the Home Screen app: pair ClipSync in Safari too, and
        unlock it once. The text travels in the part of the address after{" "}
        <code>#</code>, which browsers never send to a server.
      </p>
      <ul>
        <li>
          <b>Back Tap:</b> Settings → Accessibility → Touch → Back Tap → Double
          Tap → Send to ClipSync.
        </li>
        <li>
          <b>Action Button</b> (iPhone 15 Pro and later): Settings → Action
          Button → Shortcut → Send to ClipSync.
        </li>
      </ul>

      <button onClick={onClose}>Back to ClipSync</button>
    </article>
  );
}
