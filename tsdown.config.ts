import { hostConfig, clientConfig } from './build/tsdown.client.ts'

// Standalone two-face build: host entry + browser client bundle.
export default () => [
  hostConfig(),
  clientConfig(),
]
