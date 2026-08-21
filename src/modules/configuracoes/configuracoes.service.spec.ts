import { Test, TestingModule } from '@nestjs/testing';
import { ConfiguracoesService } from './configuracoes.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateConfiguracaoDto } from './dto/update-configuracao.dto';

/**
 * Configuração global — um registro só, de id fixo 1.
 *
 * São 34 linhas, mas o `onModuleInit` merece teste por um motivo específico:
 * ele é o **bootstrap de banco novo**. Se falhar, a API sobe normalmente e só
 * quebra na primeira leitura de configuração — longe da causa, e provavelmente
 * em produção, já que em desenvolvimento o registro sempre existe.
 *
 * A idempotência é a outra metade: o `onModuleInit` roda a cada partida, e
 * criar de novo violaria a chave primária e derrubaria a inicialização.
 */

describe('ConfiguracoesService', () => {
  let service: ConfiguracoesService;
  let configuracaoFormularios: {
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    configuracaoFormularios = {
      findFirst: jest.fn().mockResolvedValue({ id: 1 }),
      create: jest.fn().mockResolvedValue({ id: 1 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfiguracoesService,
        { provide: PrismaService, useValue: { configuracaoFormularios } },
      ],
    }).compile();

    service = module.get<ConfiguracoesService>(ConfiguracoesService);
  });

  describe('partida', () => {
    it('cria o registro quando o banco está vazio', async () => {
      configuracaoFormularios.findFirst.mockResolvedValue(null);

      await service.onModuleInit();

      expect(configuracaoFormularios.create).toHaveBeenCalledWith({
        data: { id: 1 },
      });
    });

    /** Roda a cada partida: criar de novo violaria a chave primária. */
    it('não recria quando o registro já existe', async () => {
      await service.onModuleInit();

      expect(configuracaoFormularios.create).not.toHaveBeenCalled();
    });
  });

  describe('leitura e escrita', () => {
    it('lê sempre o registro de id 1', async () => {
      await service.get();

      expect(configuracaoFormularios.findFirst).toHaveBeenCalledWith({
        where: { id: 1 },
      });
    });

    it('grava sempre no registro de id 1', async () => {
      await service.update({ taxaEntrega: 8 } as UpdateConfiguracaoDto);

      expect(configuracaoFormularios.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { taxaEntrega: 8 },
      });
    });
  });
});
