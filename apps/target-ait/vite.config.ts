import aitDevtools from '@ait-co/devtools/unplugin';
import ttsc from '@ttsc/unplugin/vite';
import { defineConfig } from 'vite';

const aitDevtoolsTunnel = process.env.AIT_TUNNEL
  ? { cdp: Boolean(process.env.AIT_TUNNEL_CDP) }
  : false;

export default defineConfig(({ command, isPreview }) => ({
  plugins: [
    ...(command === 'serve' && !isPreview && process.env.MPGD_AIT_DEVTOOLS !== '0'
      ? [aitDevtools.vite({ tunnel: aitDevtoolsTunnel })]
      : []),
    ttsc({
      project: 'tsconfig.bundle.json',
      plugins: false,
    }),
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
