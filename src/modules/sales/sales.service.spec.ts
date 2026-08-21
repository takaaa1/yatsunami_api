import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSaleDto, DiscountType } from './dto/create-sale.dto';

/**
 * Aritmética de dinheiro da venda.
 *
 * 205 linhas sem teste, e a única cobertura era indireta — pelo app, que faz a
 * própria conta para exibir o total. Duas contas separadas para o mesmo número
 * é exatamente a fronteira que já rendeu defeito neste projeto; aqui a do
 * servidor, que é a que grava, fica travada.
 *
 * Dois pontos são sutis o bastante para merecerem nome:
 *
 * 1. **desconto fixo por item é por unidade**, não pelo item inteiro —
 *    `valorDesconto × quantidade`;
 * 2. **a taxa de entrega entra depois do corte em zero**, então um desconto
 *    grande nunca engole o frete.
 */

type Tx = {
  venda: { create: jest.Mock; update: jest.Mock };
  produto: { findUnique: jest.Mock };
  itemVenda: { create: jest.Mock };
};

describe('SalesService.create', () => {
  let service: SalesService;
  let tx: Tx;

  /** O total gravado no fim da transação, como texto, para comparar exato. */
  const totalGravado = () =>
    String(
      (tx.venda.update.mock.calls[0][0] as { data: { total: unknown } }).data
        .total,
    );

  const venda = (
    itens: CreateSaleDto['itens'],
    extra: Partial<CreateSaleDto> = {},
  ) => service.create('admin-1', { itens, ...extra } as CreateSaleDto);

  const item = (extra: Record<string, unknown> = {}) => ({
    produtoId: 1,
    quantidade: 1,
    precoUnitario: 10,
    ...extra,
  });

  beforeEach(async () => {
    tx = {
      venda: {
        create: jest.fn().mockResolvedValue({ id: 55 }),
        update: jest.fn().mockResolvedValue({ id: 55 }),
      },
      produto: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, variedades: [{ id: 9 }] }),
      },
      itemVenda: { create: jest.fn().mockResolvedValue({}) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: (fn: (t: Tx) => Promise<unknown>) => fn(tx),
          },
        },
      ],
    }).compile();

    service = module.get<SalesService>(SalesService);
  });

  describe('soma dos itens', () => {
    it('multiplica preço por quantidade', async () => {
      await venda([item({ quantidade: 3, precoUnitario: 10 })]);

      expect(totalGravado()).toBe('30');
    });

    it('soma vários itens', async () => {
      await venda([
        item({ quantidade: 2, precoUnitario: 35 }),
        item({ quantidade: 1, precoUnitario: 36 }),
      ]);

      expect(totalGravado()).toBe('106');
    });

    /**
     * `Decimal` existe para isto. Com ponto flutuante, `0.1 * 3` dá
     * `0.30000000000000004`, e um centavo de erro por item vira divergência de
     * caixa no fim do dia.
     */
    it('não acumula erro de ponto flutuante', async () => {
      await venda([item({ quantidade: 3, precoUnitario: 0.1 })]);

      expect(totalGravado()).toBe('0.3');
    });
  });

  describe('desconto por item', () => {
    it('percentual desconta de cada unidade', async () => {
      await venda([
        item({
          quantidade: 2,
          precoUnitario: 100,
          tipoDesconto: DiscountType.PERCENTAGE,
          valorDesconto: 10,
        }),
      ]);

      // 2 × (100 − 10) = 180
      expect(totalGravado()).toBe('180');
    });

    /**
     * O primeiro ponto sutil: o desconto fixo é **por unidade**. R$ 5 de
     * desconto em 3 unidades tira R$ 15, não R$ 5. Quem ler o campo como
     * "desconto do item" erra por um fator de quantidade.
     */
    it('fixo desconta por unidade, não do item inteiro', async () => {
      await venda([
        item({
          quantidade: 3,
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 5,
        }),
      ]);

      // 3 × (10 − 5) = 15, e não 30 − 5 = 25
      expect(totalGravado()).toBe('15');
    });

    it('desconto maior que o item zera o item, não fica negativo', async () => {
      await venda([
        item({
          quantidade: 1,
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
      ]);

      expect(totalGravado()).toBe('0');
    });

    it('um item zerado não come o valor dos outros', async () => {
      await venda([
        item({
          produtoId: 1,
          quantidade: 1,
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 50,
        }),
        item({ produtoId: 1, quantidade: 1, precoUnitario: 40 }),
      ]);

      expect(totalGravado()).toBe('40');
    });

    it('grava no item o preço e o desconto originais, não o subtotal', async () => {
      await venda([
        item({
          quantidade: 2,
          precoUnitario: 10,
          tipoDesconto: DiscountType.FIXED,
          valorDesconto: 3,
        }),
      ]);

      expect(tx.itemVenda.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          precoUnitario: 10,
          valorDesconto: 3,
          tipoDesconto: DiscountType.FIXED,
          quantidade: 2,
        }),
      });
    });
  });

  describe('desconto geral', () => {
    it('percentual incide sobre a soma dos itens já descontados', async () => {
      await venda([item({ quantidade: 1, precoUnitario: 100 })], {
        descontoGeralTipo: DiscountType.PERCENTAGE,
        descontoGeralValor: 10,
      });

      expect(totalGravado()).toBe('90');
    });

    it('fixo sai do total, uma vez só', async () => {
      await venda(
        [
          item({ quantidade: 2, precoUnitario: 50 }),
          item({ quantidade: 1, precoUnitario: 20 }),
        ],
        { descontoGeralTipo: DiscountType.FIXED, descontoGeralValor: 20 },
      );

      // 100 + 20 − 20
      expect(totalGravado()).toBe('100');
    });

    it('valor zero não é tratado como desconto', async () => {
      await venda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 0,
      });

      expect(totalGravado()).toBe('10');
    });

    it('desconto maior que a venda zera o total', async () => {
      await venda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 500,
      });

      expect(totalGravado()).toBe('0');
    });
  });

  describe('taxa de entrega', () => {
    it('é somada ao total', async () => {
      await venda([item({ precoUnitario: 40 })], { taxaEntrega: 8 });

      expect(totalGravado()).toBe('48');
    });

    /**
     * O segundo ponto sutil, e o mais fácil de quebrar numa reordenação: o
     * frete entra **depois** do corte em zero. Se entrasse antes, um desconto
     * geral maior que a venda engoliria também a taxa, e o estabelecimento
     * pagaria a entrega do próprio bolso.
     */
    it('sobrevive a um desconto que zera a venda', async () => {
      await venda([item({ precoUnitario: 10 })], {
        descontoGeralTipo: DiscountType.FIXED,
        descontoGeralValor: 500,
        taxaEntrega: 8,
      });

      expect(totalGravado()).toBe('8');
    });

    it('taxa zero não muda nada', async () => {
      await venda([item({ precoUnitario: 10 })], { taxaEntrega: 0 });

      expect(totalGravado()).toBe('10');
    });
  });

  describe('produtos e variedades', () => {
    it('recusa produto inexistente', async () => {
      tx.produto.findUnique.mockResolvedValue(null);

      await expect(venda([item()])).rejects.toThrow(NotFoundException);
    });

    it('recusa variedade que não pertence ao produto', async () => {
      tx.produto.findUnique.mockResolvedValue({
        id: 1,
        variedades: [{ id: 9 }],
      });

      await expect(venda([item({ variedadeId: 77 })])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('aceita variedade do próprio produto', async () => {
      await venda([item({ variedadeId: 9 })]);

      expect(tx.itemVenda.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ variedadeId: 9 }),
      });
    });

    it('sem variedade, grava nulo em vez de zero', async () => {
      await venda([item({ variedadeId: 0 })]);

      expect(tx.itemVenda.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ variedadeId: null }),
      });
    });
  });

  it('registra quem criou a venda', async () => {
    await venda([item()]);

    expect(tx.venda.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ criadoPor: 'admin-1' }),
    });
  });
});
