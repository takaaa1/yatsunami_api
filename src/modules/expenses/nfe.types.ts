/**
 * Recorte tipado do XML de NF-e/NFC-e depois de convertido em objeto.
 *
 * Declara só o que o `QrParserService` lê. Todos os campos são opcionais e os
 * valores numéricos chegam como string — é assim que a SEFAZ emite, e o
 * parser converte com `parseFloat` na leitura.
 */

/** Produto de um item da nota. */
export interface NfeProduto {
  xProd?: string;
  /** Quantidade comercial, ex. "1.0000". */
  qCom?: string;
  /** Valor unitário comercial, ex. "10.00". */
  vUnCom?: string;
  /** Valor total do item, ex. "10.00". */
  vProd?: string;
}

/** Item (detalhe) da nota. */
export interface NfeDetalhe {
  prod?: NfeProduto;
}

/** Totais do grupo ICMS. */
export interface NfeIcmsTotal {
  /** Valor total da nota. */
  vNF?: string;
  /** Soma dos produtos, antes de descontos. */
  vProd?: string;
  /** Desconto total. */
  vDesc?: string;
}

export interface NfeInfo {
  emit?: { xNome?: string };
  /** Data/hora de emissão em ISO-8601 com offset. */
  ide?: { dhEmi?: string };
  /** Um item vem como objeto; vários, como array. */
  det?: NfeDetalhe | NfeDetalhe[];
  total?: { ICMSTot?: NfeIcmsTotal };
}

/** Raiz do XML: `nfeProc` quando processada, `NFe` quando avulsa. */
export interface NfeRoot {
  nfeProc?: { NFe?: { infNFe?: NfeInfo } };
  NFe?: { infNFe?: NfeInfo };
}

/** Item já normalizado pelo parser, vindo do XML ou do HTML. */
export interface ItemNota {
  descricao: string;
  quantidade: number;
  valorUnitario: number;
  valor: number;
}
