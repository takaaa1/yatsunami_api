import { RealtimeGateway } from '../../modules/realtime/realtime.gateway';

export type BroadcastEventType = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Executa a mutação e, **só se ela concluir**, emite o evento de realtime.
 *
 * Se a operação lançar, a exceção propaga e nada é emitido — que é o ponto:
 * emitir antes de saber o resultado faria as telas buscarem um dado que não
 * mudou, ou pior, mostrarem uma mudança que foi revertida.
 *
 * Chamado do **controlador**, e não do serviço, porque cada endpoint tem uma
 * saída só. Vários métodos de serviço têm `return` em mais de um ramo, e
 * emitir em cada um seria fácil de esquecer ao mexer depois. A exceção é
 * quando a mutação atinge registros que só o serviço conhece — caso de
 * `OrdersService.recalculateSharedFees`, que altera N pedidos de uma vez.
 *
 * O `registro` deve levar os campos que **quem escuta usa para filtrar**, e
 * não o objeto inteiro: a lista de pedidos de um formulário, por exemplo,
 * descarta o evento que não seja do seu `dataEncomendaId`.
 *
 * Devolver `null` em `registro` **pula a emissão**. Serve para o caso em que a
 * operação conclui sem produzir registro identificável — `ExpensesService`
 * pode devolver `null`, e emitir um evento sem `id` faria toda tela que escuta
 * refazer a busca sem motivo.
 */
export async function broadcastAfter<T>(
  gateway: RealtimeGateway,
  table: string,
  eventType: BroadcastEventType,
  operacao: Promise<T>,
  registro: (resultado: T) => Record<string, unknown> | null,
): Promise<T> {
  const resultado = await operacao;
  const evento = registro(resultado);
  if (evento) {
    gateway.broadcast(table, eventType, evento);
  }
  return resultado;
}
