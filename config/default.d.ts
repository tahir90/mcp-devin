declare const config: {
  devin: {
    apiKey: string | undefined;
    orgName: string;
    baseUrl: string;
  };
  slack: {
    token: string | undefined;
    defaultChannel: string | undefined;
  };
};

export default config;
