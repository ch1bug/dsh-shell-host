// Ambient type bridge for the ported test helpers: live-config.ts emits the
// 'app-boot/config-reload' event, whose Events-interface augmentation lives in
// @deepseek-ai/dsh-app-boot source (upstream's own tests compile under the
// monorepo's aggregate tsconfigs that already load it). Importing the module
// here applies its declaration augmentation program-wide without editing the
// ported helper.
import '@deepseek-ai/dsh-app-boot'
