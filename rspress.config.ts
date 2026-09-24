import { defineConfig } from '@rspress/core';

export default defineConfig({
  root: 'docs',
  base: '/mpgd-kit/',
  siteOrigin: 'https://imjlk.github.io',
  title: 'mpgd-kit',
  description: 'Evidence-backed guides and platform contracts for mpgd-kit',
  route: {
    extensions: ['.md', '.mdx'],
  },
  markdown: {
    link: {
      checkDeadLinks: true,
      checkAnchors: true,
    },
  },
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guides', link: '/guides/platform-capabilities' },
      { text: 'Evidence', link: '/DOCUMENTATION_EVIDENCE' },
      { text: 'Spec', link: '/specs/platform-capability-snapshots' },
    ],
    sidebar: {
      '/': [
        {
          text: 'Start',
          items: [
            { text: 'Overview', link: '/' },
            { text: 'Game development', link: '/GAME_DEVELOPMENT' },
            { text: 'Platform flow', link: '/PLATFORM_GAME_FLOW' },
          ],
        },
        {
          text: 'Evidence-backed',
          items: [
            { text: 'Capabilities guide', link: '/guides/platform-capabilities' },
            { text: 'Confirmed spec', link: '/specs/platform-capability-snapshots' },
            { text: 'Evidence policy', link: '/DOCUMENTATION_EVIDENCE' },
          ],
        },
      ],
    },
  },
});
