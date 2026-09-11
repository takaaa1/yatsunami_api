import {
  comprovanteNovo,
  pagamentoJaCobre,
  reembolsoNaConfirmacao,
  situacaoDoPagamento,
  valorPagoNoRevert,
} from './pagamento-diferenca';

/** O caso real que motivou o recurso: pedido 222, R$ 221,50 pagos. */
const PAGO = '221.50';

describe('situacaoDoPagamento', () => {
  it('sem pagamento anterior, falta o total', () => {
    expect(
      situacaoDoPagamento({ totalValor: '250.00', valorPago: null }),
    ).toEqual({
      temPagamentoAnterior: false,
      total: 250,
      pago: 0,
      aPagar: 250,
      excedente: 0,
    });
  });

  it('total maior que o pago: falta a diferença', () => {
    const s = situacaoDoPagamento({ totalValor: '250.00', valorPago: PAGO });
    expect(s.aPagar).toBe(28.5);
    expect(s.excedente).toBe(0);
  });

  it('total menor que o pago: sobra o excedente', () => {
    const s = situacaoDoPagamento({ totalValor: '200.00', valorPago: PAGO });
    expect(s.aPagar).toBe(0);
    expect(s.excedente).toBe(21.5);
  });

  /** 0.3 - 0.1 em number dá 0.19999999999999998. */
  it('não acumula erro de ponto flutuante', () => {
    expect(
      situacaoDoPagamento({ totalValor: 0.3, valorPago: 0.1 }).aPagar,
    ).toBe(0.2);
  });

  it('aceita o Decimal do Prisma', () => {
    const decimal = { toString: () => '250.00' };
    expect(
      situacaoDoPagamento({ totalValor: decimal, valorPago: PAGO }).aPagar,
    ).toBe(28.5);
  });
});

describe('pagamentoJaCobre', () => {
  it('cobre quando o total é igual ou menor que o pago', () => {
    expect(pagamentoJaCobre({ totalValor: '221.50', valorPago: PAGO })).toBe(
      true,
    );
    expect(pagamentoJaCobre({ totalValor: '200.00', valorPago: PAGO })).toBe(
      true,
    );
  });

  it('não cobre quando falta pagar', () => {
    expect(pagamentoJaCobre({ totalValor: '250.00', valorPago: PAGO })).toBe(
      false,
    );
  });

  it('sem pagamento anterior, nunca cobre', () => {
    expect(pagamentoJaCobre({ totalValor: '0', valorPago: null })).toBe(false);
  });
});

describe('comprovanteNovo', () => {
  it('primeiro pagamento é integral, pelo total', () => {
    expect(
      comprovanteNovo({ totalValor: '250.00', valorPago: null }, 'diferenca'),
    ).toEqual({ tipo: 'integral', valor: 250 });
  });

  it('com pagamento anterior, a escolha da diferença cobre só o que falta', () => {
    expect(
      comprovanteNovo({ totalValor: '250.00', valorPago: PAGO }, 'diferenca'),
    ).toEqual({ tipo: 'diferenca', valor: 28.5 });
  });

  it('a escolha do total cobre o total', () => {
    expect(
      comprovanteNovo({ totalValor: '250.00', valorPago: PAGO }, 'total'),
    ).toEqual({ tipo: 'total', valor: 250 });
  });

  /** App antigo não manda a escolha; ele exibiu o QR padrão, que é o da diferença. */
  it('sem escolha, assume a diferença', () => {
    expect(
      comprovanteNovo({ totalValor: '250.00', valorPago: PAGO }, undefined)
        .tipo,
    ).toBe('diferenca');
  });
});

describe('reembolsoNaConfirmacao', () => {
  it('pagou a diferença: nada a reembolsar', () => {
    expect(
      reembolsoNaConfirmacao({ totalValor: '250.00', valorPago: PAGO }, [
        '28.50',
      ]),
    ).toBe(0);
  });

  it('pagou o total de novo: reembolsa o pagamento anterior inteiro', () => {
    expect(
      reembolsoNaConfirmacao({ totalValor: '250.00', valorPago: PAGO }, [
        '250.00',
      ]),
    ).toBe(221.5);
  });

  it('total diminuiu, sem comprovante novo: reembolsa o excedente', () => {
    expect(
      reembolsoNaConfirmacao({ totalValor: '200.00', valorPago: PAGO }, []),
    ).toBe(21.5);
  });

  it('pedido comum, sem pagamento anterior: nada a reembolsar', () => {
    expect(
      reembolsoNaConfirmacao({ totalValor: '250.00', valorPago: null }, [
        '250.00',
      ]),
    ).toBe(0);
  });
});

describe('valorPagoNoRevert', () => {
  it('é o total confirmado', () => {
    expect(
      valorPagoNoRevert({
        totalValor: '250.00',
        reembolsoValor: null,
        reembolsadoEm: null,
      }),
    ).toBe(250);
  });

  it('soma o reembolso ainda não feito — o dinheiro continua com o restaurante', () => {
    expect(
      valorPagoNoRevert({
        totalValor: '250.00',
        reembolsoValor: '221.50',
        reembolsadoEm: null,
      }),
    ).toBe(471.5);
  });

  it('ignora o reembolso já feito', () => {
    expect(
      valorPagoNoRevert({
        totalValor: '250.00',
        reembolsoValor: '221.50',
        reembolsadoEm: new Date(),
      }),
    ).toBe(250);
  });
});
