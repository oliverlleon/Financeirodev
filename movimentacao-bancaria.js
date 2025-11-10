import { collection, query, where, onSnapshot, doc, getDoc, writeBatch, runTransaction, serverTimestamp, addDoc } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

// This module will be initialized from the main script
export function initializeMovimentacaoBancaria(db, userId, commonUtils, userName) {
    if (!userId) return;

    const { formatCurrency, fromCents, toCents, showFeedback } = commonUtils;
    const currentUserName = userName;

    // DOM Elements
    const contaBancariaSelect = document.getElementById('mov-conta-bancaria-select');
    const periodoDeInput = document.getElementById('mov-periodo-de');
    const periodoAteInput = document.getElementById('mov-periodo-ate');
    const tableBody = document.getElementById('movimentacoes-bancarias-table-body');
    const selectAllCheckbox = document.getElementById('mov-select-all-checkbox');

    // KPIs
    const kpiSaldoInicial = document.getElementById('kpi-saldo-inicial');
    const kpiTotalEntradas = document.getElementById('kpi-total-entradas-mov');
    const kpiTotalSaidas = document.getElementById('kpi-total-saidas-mov');
    const kpiSaldoPeriodo = document.getElementById('kpi-saldo-periodo');
    const kpiSaldoFinal = document.getElementById('kpi-saldo-final-mov');
    const kpiSaldoAConciliar = document.getElementById('kpi-saldo-a-conciliar');

    // Action Buttons
    const conciliarBtn = document.getElementById('mov-conciliar-btn');
    const desfazerBtn = document.getElementById('mov-desfazer-conciliacao-btn');
    const estornarBtn = document.getElementById('mov-estornar-lancamento-btn');


    let currentListenerUnsubscribe = null;
    let allMovimentacoes = [];

    // --- Main Logic ---

    // Load data when filters change
    contaBancariaSelect.addEventListener('change', loadMovimentacoes);
    periodoDeInput.addEventListener('change', loadMovimentacoes);
    periodoAteInput.addEventListener('change', loadMovimentacoes);

    // Refactored data loading and rendering logic to avoid composite index queries.
    function loadMovimentacoes() {
        const contaId = contaBancariaSelect.value;

        if (currentListenerUnsubscribe) {
            currentListenerUnsubscribe();
        }

        if (!contaId) {
            tableBody.innerHTML = '<tr><td colspan="8" class="text-center p-8 text-gray-500">Selecione uma conta bancária para começar.</td></tr>';
            resetKPIs();
            return;
        }

        // Query only by account ID. Date filtering and sorting will happen client-side.
        const q = query(collection(db, `users/${userId}/movimentacoesBancarias`), where("contaBancariaId", "==", contaId));

        currentListenerUnsubscribe = onSnapshot(q, (querySnapshot) => {
            const allDocsForAccount = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            // We pass all docs to the processing function, which will handle filtering and rendering.
            processAndRender(allDocsForAccount);
        }, (error) => {
            console.error("Error fetching movimentacoesBancarias: ", error);
            tableBody.innerHTML = '<tr><td colspan="8" class="text-center p-8 text-red-500">Erro ao carregar movimentações. A consulta pode exigir um índice que não existe.</td></tr>';
        });
    }

    async function processAndRender(allDocsForAccount) {
        const contaId = contaBancariaSelect.value;
        const de = periodoDeInput.value;
        const ate = periodoAteInput.value;

        // 1. Get initial balance of the account
        const contaRef = doc(db, `users/${userId}/contasBancarias`, contaId);
        const contaSnap = await getDoc(contaRef);
        const saldoInicialConta = contaSnap.exists() ? contaSnap.data().saldoInicial || 0 : 0;

        // 2. Calculate "Saldo Anterior" (balance before the start date)
        let saldoAnterior = saldoInicialConta;
        allDocsForAccount.forEach(mov => {
            if (de && mov.dataTransacao < de) {
                if (mov.estornado !== true) {
                    saldoAnterior += mov.valor || 0;
                }
            }
        });

        // 3. Filter transactions for the selected period
        const movimentacoesPeriodo = allDocsForAccount.filter(mov => {
            if (de && mov.dataTransacao < de) return false;
            if (ate && mov.dataTransacao > ate) return false;
            return true;
        }).sort((a, b) => new Date(a.dataTransacao) - new Date(b.dataTransacao) || (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0));

        // 4. Calculate KPIs for the period
        let totalEntradas = 0;
        let totalSaidas = 0;
        let saldoAConciliar = 0;

        movimentacoesPeriodo.forEach(mov => {
             if (mov.estornado === true) return;
            const valor = mov.valor || 0;
            if (valor > 0) totalEntradas += valor;
            else totalSaidas += valor;
            if (!mov.conciliado) saldoAConciliar += valor;
        });

        const saldoPeriodo = totalEntradas + totalSaidas;
        const saldoFinal = saldoAnterior + saldoPeriodo;

        // 5. Render everything
        kpiSaldoInicial.textContent = formatCurrency(saldoAnterior);
        kpiTotalEntradas.textContent = formatCurrency(totalEntradas);
        kpiTotalSaidas.textContent = formatCurrency(Math.abs(totalSaidas));
        kpiSaldoPeriodo.textContent = formatCurrency(saldoPeriodo);
        kpiSaldoFinal.textContent = formatCurrency(saldoFinal);
        kpiSaldoAConciliar.textContent = formatCurrency(saldoAConciliar);

        renderMovimentacoes(movimentacoesPeriodo, saldoAnterior);
        // Store the filtered list globally for other functions to use
        allMovimentacoes = movimentacoesPeriodo;
        updateActionButtons();
    }

    function renderMovimentacoes(movsToRender, saldoInicial) {
        if (!tableBody) return;
        tableBody.innerHTML = '';
        if (movsToRender.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="8" class="text-center p-8 text-gray-500">Nenhuma movimentação encontrada para esta conta no período selecionado.</td></tr>';
            return;
        }

        let saldoCorrente = saldoInicial;

        movsToRender.forEach(mov => {
            const tr = document.createElement('tr');
            tr.dataset.id = mov.id;

            const valor = mov.valor || 0;
            if(mov.estornado !== true) {
                saldoCorrente += valor;
            }

            const isEstornado = mov.estornado === true;
            tr.className = isEstornado ? 'bg-gray-100 text-gray-400' : 'hover:bg-gray-50';

            const statusBadge = mov.conciliado
                ? `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Conciliado</span>`
                : `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-800">Pendente</span>`;

            const descricaoHtml = isEstornado ? `<del>${mov.descricao}</del>` : mov.descricao;
            const origemHtml = mov.origemId ? `<a href="#" class="text-blue-600 hover:underline view-origin-link" data-origin-id="${mov.origemId}" data-origin-type="${mov.origemTipo}">${mov.origemDescricao || 'Ver Origem'}</a>` : (mov.origemDescricao || 'N/A');

            tr.innerHTML = `
                <td class="p-4"><input type="checkbox" class="mov-checkbox h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500" data-id="${mov.id}" ${isEstornado ? 'disabled' : ''}></td>
                <td class="px-4 py-2 text-sm">${new Date(mov.dataTransacao + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
                <td class="px-4 py-2 text-sm w-2/5">${descricaoHtml}</td>
                <td class="px-4 py-2 text-sm">${origemHtml}</td>
                <td class="px-4 py-2 text-sm text-right text-green-600">${valor > 0 && !isEstornado ? formatCurrency(valor) : ''}</td>
                <td class="px-4 py-2 text-sm text-right text-red-600">${valor < 0 && !isEstornado ? formatCurrency(Math.abs(valor)) : ''}</td>
                <td class="px-4 py-2 text-sm text-right font-mono">${formatCurrency(saldoCorrente)}</td>
                <td class="px-4 py-2 text-center">${statusBadge}</td>
            `;
            tableBody.appendChild(tr);
        });
    }


    function resetKPIs() {
        kpiSaldoInicial.textContent = formatCurrency(0);
        kpiTotalEntradas.textContent = formatCurrency(0);
        kpiTotalSaidas.textContent = formatCurrency(0);
        kpiSaldoPeriodo.textContent = formatCurrency(0);
        kpiSaldoFinal.textContent = formatCurrency(0);
        kpiSaldoAConciliar.textContent = formatCurrency(0);
    }

    // --- Action Button Logic ---

    function getSelectedMovimentacaoIds() {
        if (!tableBody) return [];
        return Array.from(tableBody.querySelectorAll('.mov-checkbox:checked')).map(cb => cb.dataset.id);
    }

    function updateActionButtons() {
        const selectedIds = getSelectedMovimentacaoIds();
        const selectedCount = selectedIds.length;

        if (selectedCount === 0) {
            conciliarBtn.disabled = true;
            desfazerBtn.disabled = true;
            estornarBtn.disabled = true;
            return;
        }

        const selectedMovs = selectedIds.map(id => allMovimentacoes.find(m => m.id === id));
        const anyConciliado = selectedMovs.some(m => m.conciliado);
        const anyNaoConciliado = selectedMovs.some(m => !m.conciliado);
        const anyEstornado = selectedMovs.some(m => m.estornado);

        conciliarBtn.disabled = anyConciliado || anyEstornado;
        desfazerBtn.disabled = anyNaoConciliado || anyEstornado;
        estornarBtn.disabled = selectedCount !== 1 || anyEstornado;
    }

    if (tableBody) {
        tableBody.addEventListener('change', e => {
            if (e.target.classList.contains('mov-checkbox')) {
                updateActionButtons();
            }
        });
    }

     if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', () => {
            tableBody.querySelectorAll('.mov-checkbox').forEach(checkbox => {
                checkbox.checked = selectAllCheckbox.checked;
            });
            updateActionButtons();
        });
    }

    async function handleConciliacao(conciliar) {
        const selectedIds = getSelectedMovimentacaoIds();
        if (selectedIds.length === 0) return;

        const batch = writeBatch(db);
        selectedIds.forEach(id => {
            const ref = doc(db, `users/${userId}/movimentacoesBancarias`, id);
            batch.update(ref, {
                conciliado: conciliar,
                dataConciliacao: conciliar ? new Date().toISOString().split('T')[0] : null,
                usuarioConciliacao: conciliar ? "currentUserName" : null // Replace with actual user name
            });
        });

        try {
            await batch.commit();
            alert(`Operação concluída para ${selectedIds.length} lançamento(s).`);
            selectAllCheckbox.checked = false;
            updateActionButtons();
        } catch (error) {
            console.error("Erro ao atualizar conciliação:", error);
            alert("Falha ao atualizar conciliação.");
        }
    }

    if (conciliarBtn) conciliarBtn.addEventListener('click', () => handleConciliacao(true));
    if (desfazerBtn) desfazerBtn.addEventListener('click', () => handleConciliacao(false));
    if (estornarBtn) estornarBtn.addEventListener('click', handleEstorno);

    async function handleEstorno() {
        const selectedIds = getSelectedMovimentacaoIds();
        if (selectedIds.length !== 1) return;
        const movId = selectedIds[0];

        if (!confirm("Esta ação irá EXCLUIR esta movimentação e REABRIR o título original em Contas a Pagar/Receber, mantendo o histórico. Deseja continuar?")) return;

        if (estornarBtn) estornarBtn.disabled = true;

        const movRef = doc(db, `users/${userId}/movimentacoesBancarias`, movId);

        try {
            await runTransaction(db, async (transaction) => {
                // 1. LÊ OS DOCUMENTOS NECESSÁRIOS
                const movDoc = await transaction.get(movRef);
                if (!movDoc.exists()) throw new Error("Lançamento bancário não encontrado para exclusão.");

                const movData = movDoc.data();

                // Se não tiver a "ponte" para a origem, apenas deleta a movimentação manual.
                if (!movData.origemParentId || !movData.origemId || !movData.origemTipo.includes('_')) {
                    transaction.delete(movRef);
                    return; // Fim da operação para lançamentos manuais
                }

                // Se tiver a "ponte", continua para reverter a despesa/receita
                const parentCollection = movData.origemTipo === 'PAGAMENTO_DESPESA' ? 'despesas' : 'receitas';
                const subCollection = movData.origemTipo === 'PAGAMENTO_DESPESA' ? 'pagamentos' : 'recebimentos';
                const origemParentDocRef = doc(db, `users/${userId}/${parentCollection}`, movData.origemParentId);
                const origemDocRef = doc(origemParentDocRef, subCollection, movData.origemId);
                const historicoCollectionRef = collection(origemParentDocRef, subCollection);

                const [origemDoc, origemParentDocRaw] = await Promise.all([transaction.get(origemDocRef), transaction.get(origemParentDocRef)]);

                if (!origemParentDocRaw.exists()) throw new Error(`O título original (ID: ${movData.origemParentId}) não foi encontrado.`);
                if (!origemDoc.exists()) throw new Error(`O registro de pagamento/recebimento original (ID: ${movData.origemId}) não foi encontrado no histórico.`);

                const origemParentDoc = origemParentDocRaw.data();
                const pagamentoOriginalData = origemDoc.data();
                const valorPrincipalEstornado = pagamentoOriginalData.valorPrincipal || 0;
                const jurosEstornados = pagamentoOriginalData.jurosPagos || pagamentoOriginalData.jurosRecebidos || 0;
                const descontosEstornados = pagamentoOriginalData.descontosAplicados || pagamentoOriginalData.descontosConcedidos || 0;

                // 2. EXECUTA AS ALTERAÇÕES

                // Deleta a movimentação bancária da tela de conciliação
                transaction.delete(movRef);

                // Marca o registro de pagamento/recebimento original como estornado, em vez de deletar
                transaction.update(origemDocRef, { estornado: true });

                // Adiciona um novo registro de "Estorno" no histórico do título
                const novoEstornoRef = doc(historicoCollectionRef);
                transaction.set(novoEstornoRef, {
                    tipoTransacao: "Estorno",
                    dataTransacao: new Date().toISOString().split('T')[0],
                    valorPrincipal: valorPrincipalEstornado,
                    jurosPagos: jurosEstornados,
                    descontosAplicados: descontosEstornados,
                    usuarioResponsavel: currentUserName || "Sistema",
                    motivoEstorno: "Estornado via Conciliação Bancária",
                    createdAt: serverTimestamp()
                });

                // Recalcula e atualiza o título original (despesa/receita)
                const updateData = {};
                const today = new Date(); today.setHours(0, 0, 0, 0);

                if (movData.origemTipo === 'PAGAMENTO_DESPESA') {
                    updateData.totalPago = (origemParentDoc.totalPago || 0) - valorPrincipalEstornado;
                    updateData.totalJuros = (origemParentDoc.totalJuros || 0) - jurosEstornados;
                    updateData.totalDescontos = (origemParentDoc.totalDescontos || 0) - descontosEstornados;
                    updateData.valorSaldo = (origemParentDoc.valorOriginal || 0) + (updateData.totalJuros || 0) - (updateData.totalPago || 0) - (updateData.totalDescontos || 0);
                    const vencimento = new Date(origemParentDoc.vencimento + 'T00:00:00');
                    updateData.status = updateData.totalPago <= 0 ? (vencimento < today ? 'Vencido' : 'Pendente') : 'Pago Parcialmente';
                } else { // RECEBIMENTO_RECEITA
                    updateData.totalRecebido = (origemParentDoc.totalRecebido || 0) - valorPrincipalEstornado;
                    updateData.totalJuros = (origemParentDoc.totalJuros || 0) - jurosEstornados;
                    updateData.totalDescontos = (origemParentDoc.totalDescontos || 0) - descontosEstornados;
                    updateData.saldoPendente = (origemParentDoc.valorOriginal || 0) + (updateData.totalJuros || 0) - (updateData.totalRecebido || 0) - (updateData.totalDescontos || 0);
                    const vencimento = new Date((origemParentDoc.dataVencimento || origemParentDoc.vencimento) + 'T00:00:00');
                    updateData.status = updateData.totalRecebido <= 0 ? (vencimento < today ? 'Vencido' : 'Pendente') : 'Recebido Parcialmente';
                }
                transaction.update(origemParentDocRef, updateData);
            });

            showFeedback("Operação desfeita! A movimentação foi excluída e o título original reaberto com histórico.", "success");
            if(selectAllCheckbox) selectAllCheckbox.checked = false;
        } catch (error) {
            console.error("Erro ao desfazer lançamento: ", error);
            showFeedback(`Falha ao desfazer: ${error.message}`, "error");
        } finally {
            updateActionButtons();
        }
    }
}