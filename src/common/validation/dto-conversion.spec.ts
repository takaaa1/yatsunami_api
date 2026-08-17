import * as fs from 'fs';
import * as path from 'path';
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { CreateOrderDto } from '../../modules/orders/dto/create-order.dto';
import { CreateSaleDto } from '../../modules/sales/dto/create-sale.dto';
import { UpdateConfiguracaoDto } from '../../modules/configuracoes/dto/update-configuracao.dto';

/**
 * O achado §6-F: os DTOs validam com `@IsNumber()`, o app manda string em
 * alguns pontos, e isso só não quebrava porque o `ValidationPipe` roda com
 * `enableImplicitConversion: true`. A dependência era invisível — nada no
 * código dizia "isto depende daquela opção", e desligá-la quebraria escritas
 * que hoje passam caladas.
 *
 * Esta suíte é o meio de verificação que não existia. Ela monta o
 * `ValidationPipe` real **com a conversão implícita desligada** e passa as
 * cargas como o app as envia. Se algum DTO voltar a depender da opção global,
 * o teste falha aqui, e não em produção.
 */
const pipeSemConversaoImplicita = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
        enableImplicitConversion: false,
    },
});

const comoCorpo = (metatype: new () => object): ArgumentMetadata => ({
    type: 'body',
    metatype,
});

describe('DTOs não dependem de enableImplicitConversion', () => {
    it('CreateOrderDto converte número em texto, inclusive nos itens', async () => {
        const resultado = (await pipeSemConversaoImplicita.transform(
            {
                dataEncomendaId: '34',
                talheres: '2',
                taxaEntrega: '5.5',
                totalValor: '51.0',
                itens: [{ produtoId: '5', quantidade: '2', precoUnitario: '25.5' }],
            },
            comoCorpo(CreateOrderDto),
        )) as CreateOrderDto;

        expect(resultado.dataEncomendaId).toBe(34);
        expect(resultado.talheres).toBe(2);
        expect(resultado.taxaEntrega).toBe(5.5);
        expect(resultado.totalValor).toBe(51);

        // O item aninhado é o caso que mais importa: `@Type(() => OrderItemDto)`
        // resolve a classe, mas cada campo numérico dentro dela precisa do seu
        // próprio `@Type(() => Number)`.
        expect(resultado.itens[0].produtoId).toBe(5);
        expect(resultado.itens[0].quantidade).toBe(2);
        expect(resultado.itens[0].precoUnitario).toBe(25.5);
    });

    it('CreateSaleDto converte desconto, taxa e itens', async () => {
        const resultado = (await pipeSemConversaoImplicita.transform(
            {
                descontoGeralValor: '10',
                taxaEntrega: '7.5',
                itens: [
                    {
                        produtoId: '3',
                        variedadeId: '9',
                        quantidade: '4',
                        precoUnitario: '12.25',
                        valorDesconto: '1.5',
                    },
                ],
            },
            comoCorpo(CreateSaleDto),
        )) as CreateSaleDto;

        expect(resultado.descontoGeralValor).toBe(10);
        expect(resultado.taxaEntrega).toBe(7.5);
        expect(resultado.itens[0].produtoId).toBe(3);
        expect(resultado.itens[0].variedadeId).toBe(9);
        expect(resultado.itens[0].quantidade).toBe(4);
        expect(resultado.itens[0].precoUnitario).toBe(12.25);
        expect(resultado.itens[0].valorDesconto).toBe(1.5);
    });

    it('UpdateConfiguracaoDto converte os quatro valores de taxa', async () => {
        // Mexe em dinheiro: a tela de configurações manda os valores mascarados,
        // e uma taxa que chegasse como string iria para o Prisma como string.
        const resultado = (await pipeSemConversaoImplicita.transform(
            {
                taxaEntregaBase: '8',
                valorMinimoTaxaReduzida: '80',
                taxaEntregaReduzida: '4',
                valorMinimoIsencao: '150',
            },
            comoCorpo(UpdateConfiguracaoDto),
        )) as UpdateConfiguracaoDto;

        expect(resultado.taxaEntregaBase).toBe(8);
        expect(resultado.valorMinimoTaxaReduzida).toBe(80);
        expect(resultado.taxaEntregaReduzida).toBe(4);
        expect(resultado.valorMinimoIsencao).toBe(150);
    });

    it('booleano de corpo JSON não precisa de conversão', async () => {
        // Os 11 `@IsBoolean` do projeto não têm `@Type`, e não precisam: em
        // JSON, `true` chega booleano. Só texto `"true"` dependeria da opção
        // global — e não há nenhum `@Query` tipado booleano no projeto, que é
        // por onde isso apareceria.
        const resultado = (await pipeSemConversaoImplicita.transform(
            { dataEncomendaId: 34, precisaTalheres: true, itens: [] },
            comoCorpo(CreateOrderDto),
        )) as CreateOrderDto;

        expect(resultado.precisaTalheres).toBe(true);
    });

    it('continua recusando o que não é número', async () => {
        // A conversão explícita não pode virar salvo-conduto: `Number('abc')` é
        // `NaN`, e `@IsNumber()` tem de barrar.
        await expect(
            pipeSemConversaoImplicita.transform(
                { dataEncomendaId: 'abc', itens: [] },
                comoCorpo(CreateOrderDto),
            ),
        ).rejects.toThrow();
    });
});

/**
 * Guarda estrutural. Os testes acima cobrem os três caminhos de escrita mais
 * caros, não os quinze DTOs. Esta varredura cobre o resto e, mais importante,
 * pega o DTO que **ainda não existe**: quem adicionar um campo numérico sem
 * `@Type` reintroduz a dependência silenciosa que a §6-F descreve.
 */
describe('nenhum campo numérico de DTO fica sem @Type', () => {
    const raizDto = path.join(__dirname, '..', '..');

    const arquivosDto = (): string[] => {
        const encontrados: string[] = [];
        const anda = (dir: string) => {
            for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
                const caminho = path.join(dir, entrada.name);
                if (entrada.isDirectory()) anda(caminho);
                else if (entrada.name.endsWith('.dto.ts')) encontrados.push(caminho);
            }
        };
        anda(raizDto);
        return encontrados;
    };

    it('varre todos os *.dto.ts', () => {
        const semType: string[] = [];

        for (const arquivo of arquivosDto()) {
            const linhas = fs.readFileSync(arquivo, 'utf8').split(/\r?\n/);

            for (let i = 0; i < linhas.length; i++) {
                if (!/^\s*@(IsNumber|IsInt)\(/.test(linhas[i])) continue;

                // Sobe pelo bloco de decoradores desta propriedade.
                let j = i - 1;
                let temType = false;
                while (j >= 0 && /^\s*@/.test(linhas[j])) {
                    if (/^\s*@Type\(/.test(linhas[j])) temType = true;
                    j--;
                }
                if (!temType) {
                    semType.push(`${path.relative(raizDto, arquivo)}:${i + 1}`);
                }
            }
        }

        expect(semType).toEqual([]);
    });

    it('encontra os arquivos que deveria — a varredura não pode passar vazia', () => {
        // Sem isto, um erro de caminho faria o teste acima passar sempre.
        expect(arquivosDto().length).toBeGreaterThanOrEqual(15);
    });
});
