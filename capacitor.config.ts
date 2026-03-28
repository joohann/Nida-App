import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId:   'com.nida.prayertimes',
  appName: 'Nida',
  webDir:  'dist',

  plugins: {
    LocalNotifications: {
      smallIcon:  'ic_nida_notify',
      iconColor:  '#1B6B3A',
      sound:      'adhan.mp3',
    },
  },

  android: {
    allowMixedContent:             false,
    webContentsDebuggingEnabled:   false,
  },

  ios: {
    contentInset:                       'automatic',
    scrollEnabled:                      false,
    limitsNavigationsToAppBoundDomains: true,
    preferredContentMode:               'mobile',
  },

  server: {
    androidScheme: 'https',
  },
};

export default config;
