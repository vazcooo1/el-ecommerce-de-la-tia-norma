// @ts-check
import { defineConfig, fontProviders } from 'astro/config';

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL,
  // One request for the page: CSS goes inline (spec §8 Performance).
  build: { inlineStylesheets: 'always' },
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: 'Atkinson Hyperlegible Next',
      cssVariable: '--font-body',
      weights: [400, 700, 800],
      styles: ['normal'],
      subsets: ['latin'],
    },
  ],
});
