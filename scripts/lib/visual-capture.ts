export const RETINA_DPR = 2;
export const PHONE_DPR = 3;

export type CaptureViewport = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  screenWidth: number;
  screenHeight: number;
};

/**
 * CDP keeps width/height in CSS pixels and applies DPR only to the output
 * raster. A 1440x900 desktop therefore keeps its layout while producing a
 * 2880x1800 PNG, like a Retina screenshot.
 */
export function captureViewport(
  width: number,
  height: number,
  mobile = width <= 720,
): CaptureViewport {
  return {
    width,
    height,
    deviceScaleFactor: mobile ? PHONE_DPR : RETINA_DPR,
    mobile,
    screenWidth: width,
    screenHeight: height,
  };
}

const ELECTRON_CAPTURE_CSS = `
  html.capture-electron-shell {
    background: var(--bg-raised) !important;
  }
  html.capture-electron-shell .sidebar-brand::before {
    content: "";
    position: absolute;
    z-index: 3;
    top: 17px;
    left: 20px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #ff5f57;
    box-shadow: 20px 0 #febc2e, 40px 0 #28c840;
    pointer-events: none;
  }
`;

/** Runs before index.html so its platform and shell capability checks see Mac Electron. */
export function captureInitScript(options: {
  theme: "light" | "dark";
  electronMaterial: boolean;
  freezeCss?: string;
}): string {
  const { theme, electronMaterial, freezeCss } = options;
  return `
    window.__theme = ${JSON.stringify(theme)};
    try { localStorage.setItem('opensession-theme', window.__theme); } catch (e) {}
    ${
      electronMaterial
        ? `
      Object.defineProperty(window, 'os1', {
        configurable: true,
        value: { desktop: true, materialBackdrop: true }
      });
      try {
        Object.defineProperty(navigator, 'platform', {
          configurable: true,
          get: () => 'MacIntel'
        });
      } catch (e) {}
    `
        : ""
    }
    document.addEventListener('DOMContentLoaded', () => {
      const html = document.documentElement;
      html.setAttribute('data-theme', window.__theme);
      ${
        electronMaterial
          ? `
        html.dataset.platform = 'mac';
        html.classList.add('material-backdrop', 'wco', 'capture-electron-shell');
        const shellStyle = document.createElement('style');
        shellStyle.dataset.captureElectron = 'true';
        shellStyle.textContent = ${JSON.stringify(ELECTRON_CAPTURE_CSS)};
        document.head.appendChild(shellStyle);
      `
          : ""
      }
      ${
        freezeCss
          ? `
        const freezeStyle = document.createElement('style');
        freezeStyle.dataset.captureFreeze = 'true';
        freezeStyle.textContent = ${JSON.stringify(freezeCss)};
        document.head.appendChild(freezeStyle);
      `
          : ""
      }
    });
  `;
}
