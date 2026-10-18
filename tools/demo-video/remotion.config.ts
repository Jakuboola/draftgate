/**
 * The window's components import `react` from the repository root's install and Remotion imports it
 * from this directory's; two copies of React in one tree break every hook. Both resolve to this
 * directory's pinned copy.
 */
import path from 'node:path';
import { Config } from '@remotion/cli/config';

const here = (pkg: string) => path.join(process.cwd(), 'node_modules', pkg);

Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...(config.resolve?.alias as Record<string, string> | undefined),
      react: here('react'),
      'react-dom': here('react-dom'),
    },
  },
}));
