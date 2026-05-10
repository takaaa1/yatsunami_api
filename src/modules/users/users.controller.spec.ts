import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

const mockUser = {
  id: 'uuid-1',
  nome: 'João Silva',
  email: 'joao@test.com',
  role: 'user',
  ativo: true,
  criadoEm: new Date(),
};

const mockUsersService = {
  findAll: jest.fn().mockResolvedValue([mockUser]),
  findOne: jest.fn().mockResolvedValue(mockUser),
  update: jest.fn().mockResolvedValue({ ...mockUser, nome: 'Atualizado' }),
  activate: jest.fn().mockResolvedValue({ ...mockUser, ativo: true }),
  deactivate: jest.fn().mockResolvedValue({ ...mockUser, ativo: false }),
  remove: jest.fn().mockResolvedValue(undefined),
  updatePushToken: jest.fn().mockResolvedValue({}),
};

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: mockUsersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('deve retornar lista de usuários', async () => {
      mockUsersService.findAll.mockResolvedValue([mockUser]);
      const result = await controller.findAll({});
      expect(result).toEqual([mockUser]);
      expect(mockUsersService.findAll).toHaveBeenCalledWith({}, 0, 10);
    });
  });

  describe('findOne', () => {
    it('deve retornar um usuário pelo ID', async () => {
      mockUsersService.findOne.mockResolvedValue(mockUser);
      const result = await controller.findOne('uuid-1');
      expect(result).toEqual(mockUser);
    });
  });

  describe('update', () => {
    it('deve retornar usuário atualizado', async () => {
      mockUsersService.update.mockResolvedValue({
        ...mockUser,
        nome: 'Atualizado',
      });
      const result = await controller.update('uuid-1', { nome: 'Atualizado' });
      expect(result.nome).toBe('Atualizado');
    });
  });

  describe('activate', () => {
    it('deve retornar usuário com ativo=true', async () => {
      mockUsersService.activate.mockResolvedValue({ ...mockUser, ativo: true });
      const result = await controller.activate('uuid-1');
      expect(result.ativo).toBe(true);
    });
  });

  describe('deactivate', () => {
    it('deve retornar usuário com ativo=false', async () => {
      mockUsersService.deactivate.mockResolvedValue({
        ...mockUser,
        ativo: false,
      });
      const result = await controller.deactivate('uuid-1', 'current-user-id');
      expect(result.ativo).toBe(false);
    });
  });

  describe('remove', () => {
    it('deve chamar service.remove com o ID correto', async () => {
      mockUsersService.remove.mockResolvedValue(undefined);
      await controller.remove('uuid-1', 'current-user-id');
      expect(mockUsersService.remove).toHaveBeenCalledWith(
        'uuid-1',
        'current-user-id',
      );
    });
  });
});
