declare module 'virtual:routes' {
  export type SfcRoute = {
    path: string;
    filePath: string;
    paramNames: string[];
    tag?: string;
    handlerOnly?: boolean | string;
    isRedirect?: boolean | string;
    redirect?: string;
    redirectMethod?: string;
    layout?: string;
    [key: string]: unknown;
  };

  export const routes: SfcRoute[];
}

declare module '@babel/traverse' {
  const traverse: any;
  export default traverse;
}

declare module '@babel/generator' {
  const generate: any;
  export default generate;
}
