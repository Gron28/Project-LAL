declare module 'qrcode-terminal' {
  const qrcode: {
    generate(
      value: string,
      options: { small: boolean },
      callback: (qr: string) => void,
    ): void;
  };

  export default qrcode;
}
