import { dataDaVendaDoFormulario } from './sale-date';

describe('dataDaVendaDoFormulario', () => {
  const dataEntrega = new Date('2026-09-17T00:00:00.000Z');

  it('preserva o horário estimado quando ele existe', () => {
    const eta = new Date('2026-09-15T11:35:19.000Z');
    expect(dataDaVendaDoFormulario(eta, dataEntrega)).toBe(eta);
  });

  it('sem horário, usa meio-dia de São Paulo no dia do formulário', () => {
    expect(dataDaVendaDoFormulario(null, dataEntrega).toISOString()).toBe(
      '2026-09-17T15:00:00.000Z',
    );
  });
});
