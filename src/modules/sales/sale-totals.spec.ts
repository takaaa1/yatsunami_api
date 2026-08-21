import { Prisma } from '@prisma/client';
import { resumirVenda, LinhaDeVenda } from './sale-totals';
import { DiscountType } from './dto/create-sale.dto';

/**
 * A regra de dinheiro da venda, num lugar só.
 *
 * Ela existia em duas cópias: `sales.service.ts`, que grava o total, e
 * `pdf.service.ts`, que desenhava as linhas do recibo. As duas discordavam em
 * três pontos, e o recibo era o lado errado — ele imprimia linhas que não
 * fechavam com o próprio total impresso, que vem do banco.
 *
 * O que este módulo garante, e o que nenhuma das duas cópias garantia:
 *
 *     subtotal − descontoItens − descontoGeral + taxaEntrega === total
 *
 * O corte em zero é o motivo de os descontos serem devolvidos **já efetivos**:
 * um desconto de R$ 50 num item de R$ 10 tira R$ 10, não R$ 50. Devolver o
 * valor nominal é o que fazia as contas do recibo não fecharem.
 */

const item = (extra: Partial<LinhaDeVenda> = {}): LinhaDeVenda => ({
  quantidade: 1,
  precoUnitario: 10,
  ...extra,
});

const txt = (d: Prisma.Decimal) => d.toString();

describe('resumirVenda', () => {
  describe('soma dos itens', () => {
    it('multiplica preço por quantidade', () => {
      const r = resumirVenda([item({ quantidade: 3, precoUnitario: 10 })]);

      expect(txt(r.subtotal)).toBe('30');
      expect(txt(r.total)).toBe('30');
    });

    /** `Decimal` existe para isto: `0.1 * 3` em ponto flutuante dá `0.30000000000000004`. */
    it('não acumula erro de ponto flutuante', () => {
      const r = resumirVenda([item({ quantidade: 3, precoUnitario: 0.1 })]);

      expect(txt(r.total)).toBe('0.3');
    });

    it('item sem preço não quebra a conta', () => {
      const r = resumirVenda([item({ precoUnitario: null })]);

      expect(txt(r.total)).toBe('0');
    });
  });

  describe('desconto por item', () => {
    it('percentual desconta de cada unidade', () => {
      const r = resumirVenda([
        item({
          quantidade: 2,
          precoUnitario: 100,
          tipoDesconto: DiscountType.PERCENTAGE,
          valorDesconto: 10,
        }),
      ]);

      expect(txt(r.descontoItens)).toBe('20');
      expect(txt(r.total)).toBe('180');
    });

    it('fixo desconta por unidade, não do item inteiro', () => {
      const r = resumirVenda([
        item({
          quantidade: 3,
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 5,
        }),
      ]);

      expect(txt(r.total)).toBe('15');
    });

    /**
     * Primeira divergência do recibo. O servidor corta **cada item** em zero e
     * só então soma; o PDF somava um desconto global e subtraía uma vez. Com um
     * item exagerado ao lado de um normal, o recibo comia o valor do outro.
     */
    it('item zerado não come o valor dos outros', () => {
      const r = resumirVenda([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
        item({ precoUnitario: 40 }),
      ]);

      expect(txt(r.total)).toBe('40');
      // O desconto efetivo é R$ 10 — o que o item tinha —, não os R$ 50 pedidos.
      expect(txt(r.descontoItens)).toBe('10');
      expect(txt(r.subtotal)).toBe('50');
    });
  });

  describe('desconto geral', () => {
    it('percentual incide sobre a soma já descontada', () => {
      const r = resumirVenda([item({ precoUnitario: 100 })], {
        descontoGeralTipo: DiscountType.PERCENTAGE,
        descontoGeralValor: 10,
      });

      expect(txt(r.descontoGeral)).toBe('10');
      expect(txt(r.total)).toBe('90');
    });

    it('fixo sai do total, uma vez só', () => {
      const r = resumirVenda(
        [
          item({ quantidade: 2, precoUnitario: 50 }),
          item({ precoUnitario: 20 }),
        ],
        { descontoGeralTipo: DiscountType.FIXED, descontoGeralValor: 20 },
      );

      expect(txt(r.total)).toBe('100');
    });

    it('valor zero não é tratado como desconto', () => {
      const r = resumirVenda([item()], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 0,
      });

      expect(txt(r.descontoGeral)).toBe('0');
      expect(txt(r.total)).toBe('10');
    });

    /** Segunda divergência: o corte em zero do total, que o PDF não tinha. */
    it('desconto maior que a venda zera o total, e o desconto sai efetivo', () => {
      const r = resumirVenda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 500,
      });

      expect(txt(r.total)).toBe('0');
      expect(txt(r.descontoGeral)).toBe('10');
    });
  });

  describe('taxa de entrega', () => {
    it('é somada ao total', () => {
      const r = resumirVenda([item({ precoUnitario: 40 })], { taxaEntrega: 8 });

      expect(txt(r.total)).toBe('48');
    });

    /**
     * A taxa entra **depois** do corte em zero: se entrasse antes, um desconto
     * grande engoliria o frete e o estabelecimento pagaria a entrega do bolso.
     */
    it('sobrevive a um desconto que zera a venda', () => {
      const r = resumirVenda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 500,
        taxaEntrega: 8,
      });

      expect(txt(r.total)).toBe('8');
    });

    /** Terceira divergência: o PDF não conhecia a taxa — nem no tipo. */
    it('aparece no resumo para o recibo poder mostrá-la', () => {
      const r = resumirVenda([item()], { taxaEntrega: 8 });

      expect(txt(r.taxaEntrega)).toBe('8');
    });
  });

  /**
   * A invariante que existe para o recibo fechar. Sem ela, o cliente vê linhas
   * que não somam o total impresso logo abaixo delas.
   */
  describe('as linhas fecham com o total', () => {
    const conferir = (r: ReturnType<typeof resumirVenda>) =>
      txt(
        r.subtotal.sub(r.descontoItens).sub(r.descontoGeral).add(r.taxaEntrega),
      );

    it('na venda simples', () => {
      const r = resumirVenda([item({ quantidade: 2, precoUnitario: 35 })]);
      expect(conferir(r)).toBe(txt(r.total));
    });

    it('com item zerado ao lado de um normal', () => {
      const r = resumirVenda([
        item({
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
        item({ precoUnitario: 40 }),
      ]);
      expect(conferir(r)).toBe(txt(r.total));
    });

    it('com desconto geral que zera a venda e taxa de entrega', () => {
      const r = resumirVenda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 500,
        taxaEntrega: 8,
      });
      expect(conferir(r)).toBe(txt(r.total));
    });

    it('com os dois descontos e taxa juntos', () => {
      const r = resumirVenda(
        [
          item({
            quantidade: 2,
            precoUnitario: 100,
            tipoDesconto: DiscountType.PERCENTAGE,
            valorDesconto: 10,
          }),
          item({ precoUnitario: 40 }),
        ],
        {
          descontoGeralTipo: DiscountType.PERCENTAGE,
          descontoGeralValor: 10,
          taxaEntrega: 7.5,
        },
      );
      expect(conferir(r)).toBe(txt(r.total));
    });
  });
});
