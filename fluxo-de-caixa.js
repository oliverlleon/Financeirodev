import { getFirestore, collection, query, where, getDocs, doc, getDoc, addDoc, serverTimestamp, runTransaction, updateDoc, collectionGroup } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

// This function will be called from the main script when the user is authenticated.
export function initializeFluxoDeCaixa(db, userId, common) {
    const fluxoDeCaixaPage = document.getElementById('fluxo-de-caixa-page');
    if (!fluxoDeCaixaPage) return;

    // --- DOM Elements ---
    // Filters
    const periodoDeInput = document.getElementById('fluxo-periodo-de');
    const periodoAteInput = document.getElementById('fluxo-periodo-ate');
    const contaBancariaSelect = document.getElementById('fluxo-conta-bancaria');
    const conciliacaoFilterGroup = document.getElementById('fluxo-conciliacao-filter-group');

    // KPIs
    const kpiSaldoAnterior = document.getElementById('kpi-saldo-anterior');
    const kpiTotalEntradas = document.getElementById('kpi-total-entradas');
    const kpiTotalSaidas = document.getElementById('kpi-total-saidas');
    const kpiResultadoLiquido = document.getElementById('kpi-resultado-liquido');
    const kpiSaldoFinal = document.getElementById('kpi-saldo-final');

    // Tables & Content
    const extratoTableBody = document.getElementById('fluxo-extrato-table-body');
    const dreTableBody = document.getElementById('fluxo-dre-table-body');

    // Modals & Buttons
    const lancarTransferenciaBtn = document.getElementById('lancar-transferencia-btn');
    const transferenciaModal = document.getElementById('transferencia-modal');
    const closeTransferenciaModalBtn = document.getElementById('close-transferencia-modal-btn');
    const cancelTransferenciaModalBtn = document.getElementById('cancel-transferencia-modal-btn');
    const transferenciaForm = document.getElementById('transferencia-form');

    // --- State ---
    let allContasBancarias = [];
    let activeConciliacaoFilter = 'todas';
    const visaoRealizadoCheckbox = document.getElementById('visao-realizado-checkbox');
    const visaoProjetadoCheckbox = document.getElementById('visao-projetado-checkbox');
    let whatIfScenario = []; // Array to hold simulated transactions

    // --- DOM Elements (What-If Tab) ---
    const whatIfReceitaForm = document.getElementById('what-if-receita-form');
    const whatIfDespesaForm = document.getElementById('what-if-despesa-form');
    const whatIfItemsContainer = document.getElementById('what-if-items-container');
    const whatIfClearScenarioBtn = document.getElementById('what-if-clear-scenario-btn');
    const whatIfSaveScenarioBtn = document.getElementById('what-if-save-scenario-btn');
    const cenariosSalvosList = document.getElementById('cenarios-salvos-list');
    const whatIfSaldoInicialEl = document.getElementById('what-if-saldo-inicial');
    const whatIfSaldoProjetadoEl = document.getElementById('what-if-saldo-projetado');
    const whatIfSaldoSimuladoEl = document.getElementById('what-if-saldo-simulado');
    const whatIfSaldoComparadoEl = document.getElementById('what-if-saldo-comparado');
    const whatIfIncludeProjectionsCheckbox = document.getElementById('what-if-include-projections');
    let savedScenarios = [];
    let comparisonScenario = null;


    // --- Utility Functions (from common) ---
    const { formatCurrency, toCents, fromCents, showFeedback } = common;

    // --- Main Logic ---
    async function fetchTransactionsEfficiently(parentCollectionName, subcollectionName, startDate, endDate, inclusive = true) {
        // This approach is more efficient as it pre-filters parent documents by a relevant date field.
        // This reduces the number of subcollection queries needed.
        const parentDateFilterField = parentCollectionName === 'despesas' ? 'vencimento' : 'dataVencimento';

        // Create a broader query on the parent collection.
        // We fetch parents from a wider date range to catch transactions that might have been paid/received
        // outside their due date but still fall within our cash flow period.
        let parentQuery = collection(db, `users/${userId}/${parentCollectionName}`);

        // The query for subcollections will be precise, so the parent query can be broader.
        // This is a balance between performance and correctness.
        // For simplicity in this fix, we'll still fetch all parents, but the sub-query will be precise.
        // A more advanced optimization could pre-filter parents by date.

        const parentDocsSnapshot = await getDocs(parentQuery);

        const promises = parentDocsSnapshot.docs.map(parentDoc => {
            let subcollectionQuery = collection(parentDoc.ref, subcollectionName);

            // Apply the precise date filtering at the subcollection level.
            if (startDate) {
                 subcollectionQuery = query(subcollectionQuery, where('dataTransacao', inclusive ? '>=' : '<', startDate));
            }
            if (endDate) {
                 subcollectionQuery = query(subcollectionQuery, where('dataTransacao', inclusive ? '<=' : '<', endDate));
            }

            return getDocs(subcollectionQuery);
        });

        const querySnapshots = await Promise.all(promises);
        return querySnapshots.flatMap(snapshot => snapshot.docs);
    }

    async function fetchProjectedTransactions(startDate, endDate) {
        const unifiedProjected = [];
        const planoContasMap = new Map();
        const planoContasSnap = await getDocs(collection(db, `users/${userId}/planosDeContas`));
        planoContasSnap.forEach(doc => planoContasMap.set(doc.id, doc.data()));

        // Fetch ALL pending expenses and filter in code to avoid composite indexes
        const despesasQuery = collection(db, `users/${userId}/despesas`);
        const despesasSnap = await getDocs(despesasQuery);
        despesasSnap.forEach(doc => {
            const despesaData = doc.data();
            const status = despesaData.status || 'Pendente';
            // Manual filtering
            if (['Pendente', 'Vencido', 'Pago Parcialmente'].includes(status) && despesaData.vencimento >= startDate && despesaData.vencimento <= endDate) {
                const categoria = planoContasMap.get(despesaData.categoriaId);
                unifiedProjected.push({
                    id: doc.id,
                    isProjected: true,
                    data: despesaData.vencimento,
                    descricao: `(Projetado) ${despesaData.descricao}`,
                    participante: despesaData.favorecidoNome || 'N/A',
                    planoDeConta: categoria ? categoria.nome : 'N/A',
                    dataVencimento: despesaData.vencimento,
                    entrada: 0,
                    saida: despesaData.valorSaldo || despesaData.valorOriginal,
                    juros: 0,
                    desconto: 0,
                    conciliado: false,
                    type: 'despesa_projetada'
                });
            }
        });

        // Fetch ALL pending revenues and filter in code
        const receitasQuery = collection(db, `users/${userId}/receitas`);
        const receitasSnap = await getDocs(receitasQuery);
        receitasSnap.forEach(doc => {
            const receitaData = doc.data();
            const status = receitaData.status || 'Pendente';
            const dataVencimento = receitaData.dataVencimento || receitaData.vencimento;
            // Manual filtering
            if (['Pendente', 'Vencido', 'Recebido Parcialmente'].includes(status) && dataVencimento >= startDate && dataVencimento <= endDate) {
                const categoria = planoContasMap.get(receitaData.categoriaId);
                unifiedProjected.push({
                    id: doc.id,
                    isProjected: true,
                    data: dataVencimento,
                    descricao: `(Projetado) ${receitaData.descricao}`,
                    participante: receitaData.clienteNome || 'N/A',
                    planoDeConta: categoria ? categoria.nome : 'N/A',
                    dataVencimento: dataVencimento,
                    entrada: receitaData.saldoPendente || receitaData.valorOriginal,
                    saida: 0,
                    juros: 0,
                    desconto: 0,
                    conciliado: false,
                    type: 'receita_projetada'
                });
            }
        });

        return unifiedProjected;
    }

    async function calculateAndRenderCashFlow() {
        const startDate = periodoDeInput.value;
        const endDate = periodoAteInput.value;
        const contaId = contaBancariaSelect.value;
        const showRealizado = visaoRealizadoCheckbox.checked;
        const showProjetado = visaoProjetadoCheckbox.checked;

        if (!startDate || !endDate) {
            extratoTableBody.innerHTML = `<tr><td colspan="12" class="text-center p-8 text-gray-500">Por favor, selecione um período para começar.</td></tr>`;
            return;
        }
        if (!showRealizado && !showProjetado) {
            extratoTableBody.innerHTML = `<tr><td colspan="12" class="text-center p-8 text-gray-500">Selecione uma visão (Realizado e/ou Projetado).</td></tr>`;
            renderKPIs({ saldoAnterior: 0, totalEntradas: 0, totalSaidas: 0, resultadoLiquido: 0, saldoFinal: 0 });
            destroyAllCharts(); // Correct function to clear charts
            renderDRE([]);
            return;
        }

        extratoTableBody.innerHTML = `<tr><td colspan="12" class="text-center p-8 text-gray-500">Carregando dados...</td></tr>`;

        try {
            const saldoAnterior = await calculateSaldoAnterior(startDate, contaId);
            let unifiedTransactions = [];

            if (showRealizado) {
                const [pagamentos, recebimentos, transferencias] = await Promise.all([
                    fetchTransactionsEfficiently('despesas', 'pagamentos', startDate, endDate),
                    fetchTransactionsEfficiently('receitas', 'recebimentos', startDate, endDate),
                    fetchCollection('transferencias', startDate, endDate)
                ]);
                const realizedTransactions = await enrichAndUnifyTransactions(pagamentos, recebimentos, transferencias);
                unifiedTransactions.push(...realizedTransactions);
            }

            if (showProjetado) {
                const projectedTransactions = await fetchProjectedTransactions(startDate, endDate);
                unifiedTransactions.push(...projectedTransactions);
            }

            // Add What-If scenario transactions
            const simulatedTransactions = whatIfScenario.map(item => ({
                ...item,
                isProjected: true,
                isSimulated: true,
                isComparison: false,
                descricao: `(Simulado) ${item.descricao}`,
                participante: 'Simulação',
                planoDeConta: 'Simulação',
                dataVencimento: item.data,
                entrada: item.type === 'receita' ? item.valor : 0,
                saida: item.type === 'despesa' ? item.valor : 0,
            }));
            unifiedTransactions.push(...simulatedTransactions);

            if (comparisonScenario) {
                const comparisonTransactions = comparisonScenario.map(item => ({
                    ...item,
                    isProjected: true,
                    isSimulated: true,
                    isComparison: true,
                    descricao: `(Comparado) ${item.descricao}`,
                    participante: 'Comparação',
                    planoDeConta: 'Comparação',
                    dataVencimento: item.data,
                    entrada: item.type === 'receita' ? item.valor : 0,
                    saida: item.type === 'despesa' ? item.valor : 0,
                }));
                unifiedTransactions.push(...comparisonTransactions);
            }

            unifiedTransactions.sort((a, b) => new Date(a.data) - new Date(b.data));

            // 4. Apply Filters
            unifiedTransactions = applyFilters(unifiedTransactions, contaId, activeConciliacaoFilter);

            // 5. Calculate KPIs
            const kpis = calculateKPIs(saldoAnterior, unifiedTransactions, contaId);

            // 6. Render UI
            renderKPIs(kpis);
            renderExtrato(unifiedTransactions, kpis.saldoAnterior);
            renderDRE(unifiedTransactions);
            renderAllNewCharts(unifiedTransactions, kpis.saldoAnterior);

        } catch (error) {
            console.error("Error calculating cash flow:", error);
            extratoTableBody.innerHTML = `<tr><td colspan="12" class="text-center p-8 text-red-500">Ocorreu um erro ao carregar os dados. Verifique o console para mais detalhes.</td></tr>`;
        }
    }

    async function calculateSaldoAnterior(startDate, contaId) {
        // 1. Get initial balance sum
        let saldoAnterior = 0;
        if (contaId === 'todas') {
            allContasBancarias.forEach(conta => {
                saldoAnterior += conta.saldoInicial || 0;
            });
        } else {
            const contaEspecifica = allContasBancarias.find(c => c.id === contaId);
            if (contaEspecifica) {
                saldoAnterior = contaEspecifica.saldoInicial || 0;
            }
        }

        // 2. Get past transactions
        const [pagamentos, recebimentos, transferencias] = await Promise.all([
            fetchTransactionsEfficiently('despesas', 'pagamentos', null, startDate, false),
            fetchTransactionsEfficiently('receitas', 'recebimentos', null, startDate, false),
            fetchCollection('transferencias', null, startDate, false)
        ]);

        const allTransactions = await enrichAndUnifyTransactions(pagamentos, recebimentos, transferencias);
        const filteredTransactions = applyFilters(allTransactions, contaId, 'todas');

        // 3. Add effect of past transactions to the initial balance
        filteredTransactions.forEach(t => {
            if (t.type === 'transferencia') {
                if (contaId !== 'todas') {
                    if (t.contaDestinoId === contaId) saldoAnterior += t.valor;
                    if (t.contaOrigemId === contaId) saldoAnterior -= t.valor;
                }
                // If 'todas', transfers are ignored as they are internal.
            } else {
                saldoAnterior += (t.entrada || 0) - (t.saida || 0);
            }
        });

        return saldoAnterior;
    }

    async function fetchCollection(collName, startDate, endDate, inclusive = true) {
        let q = query(collection(db, `users/${userId}/${collName}`));
         if (startDate) {
            q = query(q, where('dataTransacao', inclusive ? '>=' : '<', startDate));
        }
        if (endDate) {
            q = query(q, where('dataTransacao', inclusive ? '<=' : '<', endDate));
        }
        const snapshot = await getDocs(q);
        return snapshot.docs;
    }

    async function enrichAndUnifyTransactions(pagamentos, recebimentos, transferencias) {
        const unified = [];
        const planoContasMap = new Map();
        const planoContasSnap = await getDocs(collection(db, `users/${userId}/planosDeContas`));
        planoContasSnap.forEach(doc => {
            planoContasMap.set(doc.id, doc.data());
        });

        for (const doc of pagamentos) {
            const data = doc.data();
            if (data.estornado === true || data.tipoTransacao === 'Estorno') continue;
            const parentDespesaRef = doc.ref.parent.parent;
            if (parentDespesaRef) {
                const despesaSnap = await getDoc(parentDespesaRef);
                if (despesaSnap.exists()) {
                    const despesaData = despesaSnap.data();
                    const categoria = planoContasMap.get(despesaData.categoriaId);
                    unified.push({
                        id: doc.id,
                        parentId: parentDespesaRef.id,
                        data: data.dataTransacao,
                        descricao: despesaData.descricao,
                        participante: despesaData.favorecidoNome || 'N/A',
                        planoDeConta: categoria ? categoria.nome : 'N/A',
                        dataVencimento: despesaData.vencimento,
                        tipoAtividade: categoria ? categoria.tipoDeAtividade : 'Operacional',
                        entrada: 0,
                        saida: data.valorPrincipal || 0,
                        juros: data.jurosPagos || 0,
                        desconto: data.descontosAplicados || 0,
                        contaId: data.contaSaidaId,
                        conciliado: data.conciliado || false,
                        type: 'pagamento'
                    });
                }
            }
        }

        for (const doc of recebimentos) {
            const data = doc.data();
            if (data.estornado === true || data.tipoTransacao === 'Estorno') continue;
            const parentReceitaRef = doc.ref.parent.parent;
             if (parentReceitaRef) {
                const receitaSnap = await getDoc(parentReceitaRef);
                 if (receitaSnap.exists()) {
                    const receitaData = receitaSnap.data();
                    const categoria = planoContasMap.get(receitaData.categoriaId);
                    unified.push({
                        id: doc.id,
                        parentId: parentReceitaRef.id,
                        data: data.dataTransacao,
                        descricao: receitaData.descricao,
                        participante: receitaData.clienteNome || 'N/A',
                        planoDeConta: categoria ? categoria.nome : 'N/A',
                        dataVencimento: receitaData.dataVencimento,
                        tipoAtividade: categoria ? categoria.tipoDeAtividade : 'Operacional',
                        entrada: data.valorPrincipal || 0,
                        saida: 0,
                        juros: data.jurosRecebidos || 0,
                        desconto: data.descontosConcedidos || 0,
                        contaId: data.contaEntradaId,
                        conciliado: data.conciliado || false,
                        type: 'recebimento'
                    });
                }
            }
        }

        for (const doc of transferencias) {
            const data = doc.data();
            unified.push({
                id: doc.id,
                data: data.dataTransacao,
                descricao: `Transferência de ${data.contaOrigemNome} para ${data.contaDestinoNome}`,
                participante: 'Interno',
                planoDeConta: 'Transferência',
                dataVencimento: data.dataTransacao, // Vencimento é a própria data
                tipoAtividade: 'N/A',
                valor: data.valor, // Valor único para ser tratado na renderização
                juros: 0,
                desconto: 0,
                contaOrigemId: data.contaOrigemId,
                contaDestinoId: data.contaDestinoId,
                conciliado: data.conciliado || false,
                type: 'transferencia'
            });
        }

        return unified.sort((a, b) => new Date(a.data) - new Date(b.data));
    }

    function applyFilters(transactions, contaId, conciliacaoStatus) {
        return transactions.filter(t => {
            // Filter by Bank Account
            let contaMatch = true;
            if (contaId !== 'todas') {
                if (t.type === 'transferencia') {
                    contaMatch = t.contaOrigemId === contaId || t.contaDestinoId === contaId;
                } else {
                    contaMatch = t.contaId === contaId;
                }
            }
            if (!contaMatch) return false;

            // Filter by Conciliation Status
            let conciliacaoMatch = true;
            if (conciliacaoStatus !== 'todas') {
                const expectedStatus = conciliacaoStatus === 'conciliadas';
                conciliacaoMatch = t.conciliado === expectedStatus;
            }
            return conciliacaoMatch;
        });
    }

    function calculateKPIs(saldoAnterior, transactions, contaId) {
        let totalEntradas = 0;
        let totalSaidas = 0;

        transactions.forEach(t => {
            if (t.type === 'transferencia') {
                // Only count in KPIs if a specific account is selected
                if (contaId !== 'todas') {
                    if (t.contaDestinoId === contaId) totalEntradas += t.valor;
                    if (t.contaOrigemId === contaId) totalSaidas += t.valor;
                }
            } else {
                totalEntradas += t.entrada || 0;
                totalSaidas += t.saida || 0;
            }
        });

        const resultadoLiquido = totalEntradas - totalSaidas;
        const saldoFinal = saldoAnterior + resultadoLiquido;

        return { saldoAnterior, totalEntradas, totalSaidas, resultadoLiquido, saldoFinal };
    }

    function renderKPIs(kpis) {
        kpiSaldoAnterior.textContent = formatCurrency(kpis.saldoAnterior);
        kpiTotalEntradas.textContent = formatCurrency(kpis.totalEntradas);
        kpiTotalSaidas.textContent = formatCurrency(kpis.totalSaidas);
        kpiResultadoLiquido.textContent = formatCurrency(kpis.resultadoLiquido);
        kpiSaldoFinal.textContent = formatCurrency(kpis.saldoFinal);

        kpiResultadoLiquido.classList.toggle('text-red-700', kpis.resultadoLiquido < 0);
        kpiResultadoLiquido.classList.toggle('text-green-700', kpis.resultadoLiquido >= 0);
    }

    function renderExtrato(transactions, saldoInicial) {
        extratoTableBody.innerHTML = '';
        if (transactions.length === 0) {
            extratoTableBody.innerHTML = `<tr><td colspan="12" class="text-center p-8 text-gray-500">Nenhuma transação encontrada para os filtros selecionados.</td></tr>`;
            return;
        }

        const showRealizado = visaoRealizadoCheckbox.checked;
        const showProjetado = visaoProjetadoCheckbox.checked;
        const showBoth = showRealizado && showProjetado;

        let saldoAcumulado = saldoInicial;
        const contaFiltrada = contaBancariaSelect.value;

        transactions.forEach(t => {
            const tr = document.createElement('tr');
            let entrada = t.entrada || 0;
            let saida = t.saida || 0;

            if (t.type === 'transferencia') {
                if (contaFiltrada === 'todas') return;
                if (t.contaDestinoId === contaFiltrada) entrada = t.valor;
                else if (t.contaOrigemId === contaFiltrada) saida = t.valor;
                else return;
            }

            saldoAcumulado += (entrada - saida);

            const rowClass = showBoth && t.isProjected ? 'bg-yellow-50' : (t.conciliado ? 'bg-green-50' : 'bg-white');
            tr.className = rowClass;

            tr.innerHTML = `
                <td class="p-4"><input type="checkbox" class="fluxo-checkbox h-4 w-4 text-blue-600 border-gray-300 rounded" data-id="${t.id}" data-parent-id="${t.parentId}" data-type="${t.type}" ${t.conciliado ? 'checked' : ''} ${t.isProjected ? 'disabled' : ''}></td>
                <td class="px-4 py-2 text-sm text-gray-700">${new Date(t.data + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
                <td class="px-4 py-2 text-sm text-gray-800">${t.descricao}</td>
                <td class="px-4 py-2 text-sm text-gray-600">${t.participante}</td>
                <td class="px-4 py-2 text-sm text-gray-600">${t.planoDeConta}</td>
                <td class="px-4 py-2 text-sm text-gray-600">${new Date(t.dataVencimento + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
                <td class="px-4 py-2 text-sm text-right ${t.isProjected ? 'text-blue-500' : 'text-green-600'}">${entrada > 0 ? formatCurrency(entrada) : ''}</td>
                <td class="px-4 py-2 text-sm text-right ${t.isProjected ? 'text-blue-500' : 'text-red-600'}">${saida > 0 ? formatCurrency(saida) : ''}</td>
                <td class="px-4 py-2 text-sm text-right text-orange-600">${t.juros > 0 ? formatCurrency(t.juros) : ''}</td>
                <td class="px-4 py-2 text-sm text-right text-yellow-600">${t.desconto > 0 ? formatCurrency(t.desconto) : ''}</td>
                <td class="px-4 py-2 text-sm text-right font-medium">${formatCurrency(saldoAcumulado)}</td>
            `;
            extratoTableBody.appendChild(tr);
        });
    }

    function renderDRE(transactions) {
        dreTableBody.innerHTML = '';
        if (transactions.length === 0) {
            dreTableBody.innerHTML = `<tr><td colspan="3" class="text-center p-8 text-gray-500">Nenhuma transação encontrada para gerar o DRE.</td></tr>`;
            return;
        }
        const dreData = {
            Operacional: { entradas: 0, saidas: 0, details: {} },
            Investimento: { entradas: 0, saidas: 0, details: {} },
            Financiamento: { entradas: 0, saidas: 0, details: {} },
        };
        let totalEntradasGeral = 0;
        let totalSaidasGeral = 0;

        transactions.forEach(t => {
            if (t.type === 'transferencia') return;

            const atividade = t.tipoAtividade || 'Operacional';
            const categoria = t.categoria || 'Sem Categoria';

            if (!dreData[atividade]) dreData[atividade] = { entradas: 0, saidas: 0, details: {} };
            if (!dreData[atividade].details[categoria]) dreData[atividade].details[categoria] = 0;

            const valorEntrada = t.entrada || 0;
            const valorSaida = t.saida || 0;

            dreData[atividade].details[categoria] += (valorEntrada - valorSaida);
            dreData[atividade].entradas += valorEntrada;
            dreData[atividade].saidas += valorSaida;
            totalEntradasGeral += valorEntrada;
            totalSaidasGeral += valorSaida;
        });

        function createRow(text, value, isHeader = false, isSubHeader = false, isTotal = false, isSubTotal = false, percentageOf = null) {
            const tr = document.createElement('tr');
            let percentageHTML = '';
            if (percentageOf !== null && percentageOf !== 0) {
                const perc = (Math.abs(value) / Math.abs(percentageOf)) * 100;
                percentageHTML = `<td class="px-6 py-3 text-sm text-right text-gray-500">${perc.toFixed(2)}%</td>`;
            } else {
                percentageHTML = `<td class="px-6 py-3"></td>`;
            }

            tr.innerHTML = `
                <td class="px-6 py-3 text-sm ${isHeader ? 'font-bold text-gray-800' : (isSubHeader || isSubTotal ? 'font-semibold pl-10' : 'pl-14')}">${text}</td>
                <td class="px-6 py-3 text-sm text-right font-medium ${value < 0 ? 'text-red-600' : 'text-gray-800'}">${formatCurrency(value)}</td>
                ${percentageHTML}
            `;
            if (isSubTotal) tr.classList.add('bg-gray-50');
            return tr;
        }

        Object.keys(dreData).forEach(atividade => {
            const data = dreData[atividade];
            const fluxoCaixaAtividade = data.entradas - data.saidas;
            dreTableBody.appendChild(createRow(`Fluxo de Caixa das Atividades de ${atividade}`, fluxoCaixaAtividade, true));

            Object.keys(data.details).sort().forEach(categoria => {
                const valorCategoria = data.details[categoria];
                 if(valorCategoria > 0) {
                    dreTableBody.appendChild(createRow(categoria, valorCategoria, false, false, false, false, totalEntradasGeral));
                 } else {
                    dreTableBody.appendChild(createRow(categoria, valorCategoria, false, false, false, false, totalSaidasGeral));
                 }
            });
            dreTableBody.appendChild(createRow(`(=) Saldo das Atividades de ${atividade}`, fluxoCaixaAtividade, false, false, false, true));
        });

         const geracaoLiquida = Object.values(dreData).reduce((acc, curr) => acc + (curr.entradas - curr.saidas), 0);
         dreTableBody.appendChild(createRow('(=) GERAÇÃO LÍQUIDA DE CAIXA', geracaoLiquida, false, false, true, true));
    }

    // --- New Charting Logic ---
    let chartInstances = {};

    function destroyAllCharts() {
        Object.values(chartInstances).forEach(chart => chart.destroy());
        chartInstances = {};
    }

    function renderAllNewCharts(transactions, saldoAnterior) {
        destroyAllCharts();

        // 1. Receita vs. Despesa Mensal
        const receitaVsDespesaData = processReceitaVsDespesaData(transactions);
        renderReceitaVsDespesaChart(receitaVsDespesaData);

        // 2. Acumulado Mensal
        const acumuladoMensalData = processAcumuladoMensalData(transactions);
        renderAcumuladoMensalChart(acumuladoMensalData);

        // 3. Evolução do Saldo da Conta
        const evolucaoSaldoData = processEvolucaoSaldoData(transactions, saldoAnterior);
        renderEvolucaoSaldoChart(evolucaoSaldoData);

        // 4. Análise de Despesas por Categoria
        const despesasCategoriaData = processDespesasCategoriaData(transactions);
        renderDespesasCategoriaChart(despesasCategoriaData);

        // 5. Top 5 Despesas e Receitas
        const { topReceitas, topDespesas } = processTop5Data(transactions);
        renderTop5ReceitasChart(topReceitas);
        renderTop5DespesasChart(topDespesas);

        // 6. Comparativo de Períodos
        // This will require an additional data fetch, handled inside its process function.
        processAndRenderComparativoPeriodos();

        // 7. What-If Chart
        const whatIfData = processWhatIfEvolucaoSaldoData(transactions, saldoAnterior);
        renderWhatIfEvolucaoSaldoChart(whatIfData);

        const showProjetado = visaoProjetadoCheckbox.checked;
        const showRealizado = visaoRealizadoCheckbox.checked;

        whatIfSaldoInicialEl.textContent = showRealizado ? formatCurrency(saldoAnterior) : 'N/A';
        whatIfSaldoProjetadoEl.textContent = showProjetado ? formatCurrency(whatIfData.projetadoData.length > 0 ? whatIfData.projetadoData[whatIfData.projetadoData.length - 1] * 100 : saldoAnterior) : 'N/A';
        whatIfSaldoSimuladoEl.textContent = whatIfScenario.length > 0 ? formatCurrency(whatIfData.simuladoData.length > 0 ? whatIfData.simuladoData[whatIfData.simuladoData.length - 1] * 100 : saldoAnterior) : 'N/A';

        whatIfSaldoProjetadoEl.parentElement.classList.toggle('hidden', !showProjetado);
        whatIfSaldoSimuladoEl.parentElement.classList.toggle('hidden', whatIfScenario.length === 0);

        whatIfSaldoComparadoEl.textContent = formatCurrency(whatIfData.comparadoData.length > 0 ? whatIfData.comparadoData[whatIfData.comparadoData.length - 1] * 100 : 0);
        whatIfSaldoComparadoEl.parentElement.classList.toggle('hidden', !comparisonScenario);
    }

    // --- Data Processing Functions ---
    function processWhatIfEvolucaoSaldoData(transactions, saldoAnterior) {
        const includeProjections = whatIfIncludeProjectionsCheckbox.checked;
        const dailyChanges = {};

        // Aggregate all changes by day and type
        transactions.forEach(t => {
            const day = t.data;
            if (!day) {
                console.warn("Transaction without a date found:", t);
                return; // Skip this transaction
            }
            if (!dailyChanges[day]) {
                dailyChanges[day] = { realizado: 0, projetado: 0, simulado: 0, comparado: 0 };
            }
            const entrada = typeof t.entrada === 'number' ? t.entrada : 0;
            const saida = typeof t.saida === 'number' ? t.saida : 0;
            const netChange = entrada - saida;

            if (t.isComparison) {
                dailyChanges[day].comparado += netChange;
            } else if (t.isSimulated) {
                dailyChanges[day].simulado += netChange;
            } else if (t.isProjected) {
                dailyChanges[day].projetado += netChange;
            } else {
                dailyChanges[day].realizado += netChange;
            }
        });

        const sortedDays = Object.keys(dailyChanges).sort();
        const labels = [];
        const realizadoData = [];
        const projetadoData = [];
        const simuladoData = [];
        const comparadoData = [];

        let runningSaldoRealizado = saldoAnterior;
        let runningSaldoProjetado = saldoAnterior;
        let runningSaldoSimulado = includeProjections ? saldoAnterior : saldoAnterior; // Initialize based on projection inclusion
        let runningSaldoComparado = includeProjections ? saldoAnterior : saldoAnterior; // Initialize based on projection inclusion


        sortedDays.forEach(day => {
            labels.push(new Date(day + 'T00:00:00').toLocaleDateString('pt-BR'));
            const changes = dailyChanges[day];

            // Update the cumulative balances correctly
            runningSaldoRealizado += changes.realizado;
            runningSaldoProjetado += changes.realizado + changes.projetado;

            if (includeProjections) {
                runningSaldoSimulado = runningSaldoProjetado + changes.simulado;
                runningSaldoComparado = runningSaldoProjetado + changes.comparado;
            } else {
                runningSaldoSimulado = runningSaldoRealizado + changes.simulado;
                runningSaldoComparado = runningSaldoRealizado + changes.comparado;
            }


            realizadoData.push(runningSaldoRealizado / 100);
            projetadoData.push(runningSaldoProjetado / 100);
            simuladoData.push(runningSaldoSimulado / 100);
            comparadoData.push(runningSaldoComparado / 100);
        });

        return { labels, realizadoData, projetadoData, simuladoData, comparadoData };
    }
    function processReceitaVsDespesaData(transactions) {
        const monthlyData = {};
        const showRealizado = visaoRealizadoCheckbox.checked;
        const showProjetado = visaoProjetadoCheckbox.checked;

        transactions.forEach(t => {
            if (!showRealizado && !t.isProjected) return;
            if (!showProjetado && t.isProjected) return;

            const month = t.data.substring(0, 7); // "YYYY-MM"
            if (!monthlyData[month]) {
                monthlyData[month] = { receitas: 0, despesas: 0 };
            }
            monthlyData[month].receitas += t.entrada || 0;
            monthlyData[month].despesas += t.saida || 0;
        });

        const sortedMonths = Object.keys(monthlyData).sort();
        const labels = sortedMonths.map(month => {
            const [year, m] = month.split('-');
            return new Date(year, m - 1).toLocaleString('pt-BR', { month: 'short', year: 'numeric' });
        });
        const receitas = sortedMonths.map(month => monthlyData[month].receitas / 100);
        const despesas = sortedMonths.map(month => monthlyData[month].despesas / 100);

        return { labels, receitas, despesas };
    }

    function processAcumuladoMensalData(transactions) {
        const monthlyData = processReceitaVsDespesaData(transactions); // Reuse the monthly aggregation
        const labels = monthlyData.labels;
        let acumuladoReceitas = 0;
        let acumuladoDespesas = 0;

        const receitasAcumuladas = monthlyData.receitas.map(valor => {
            acumuladoReceitas += valor;
            return acumuladoReceitas;
        });

        const despesasAcumuladas = monthlyData.despesas.map(valor => {
            acumuladoDespesas += valor;
            return acumuladoDespesas;
        });

        return { labels, receitasAcumuladas, despesasAcumuladas };
    }

    function processEvolucaoSaldoData(transactions, saldoAnterior) {
        const dailyData = {};
        transactions.forEach(t => {
            const day = t.data;
            if (!dailyData[day]) {
                dailyData[day] = { entradas: 0, saidas: 0, isProjected: t.isProjected };
            }
            dailyData[day].entradas += t.entrada || 0;
            dailyData[day].saidas += t.saida || 0;
            // If a day has both realized and projected, mark it as realized
            if (!t.isProjected) {
                dailyData[day].isProjected = false;
            }
        });

        const sortedDays = Object.keys(dailyData).sort();
        const labels = [];
        const dataPoints = [];
        let saldoAcumulado = saldoAnterior;
        let lastRealizedDayIndex = -1;

        sortedDays.forEach((day, index) => {
            labels.push(new Date(day + 'T00:00:00').toLocaleDateString('pt-BR'));
            const netChange = dailyData[day].entradas - dailyData[day].saidas;
            saldoAcumulado += netChange;
            dataPoints.push(saldoAcumulado / 100);
            if (!dailyData[day].isProjected) {
                lastRealizedDayIndex = index;
            }
        });

        return { labels, dataPoints, lastRealizedDayIndex };
    }

    function processDespesasCategoriaData(transactions) {
        const monthlyData = {};
        const allCategories = new Set();

        transactions.forEach(t => {
            if (t.saida > 0) {
                const month = t.data.substring(0, 7);
                const category = t.planoDeConta || 'Sem Categoria';
                allCategories.add(category);

                if (!monthlyData[month]) {
                    monthlyData[month] = {};
                }
                if (!monthlyData[month][category]) {
                    monthlyData[month][category] = 0;
                }
                monthlyData[month][category] += t.saida;
            }
        });

        const sortedMonths = Object.keys(monthlyData).sort();
        const labels = sortedMonths.map(month => {
            const [year, m] = month.split('-');
            return new Date(year, m - 1).toLocaleString('pt-BR', { month: 'short', year: 'numeric' });
        });

        const datasets = Array.from(allCategories).map(category => {
            const data = sortedMonths.map(month => (monthlyData[month][category] || 0) / 100);
            return {
                label: category,
                data: data,
                // backgroundColor will be assigned in the render function for better color cycling
            };
        });

        return { labels, datasets };
    }

    function processTop5Data(transactions) {
        const receitasPorCategoria = {};
        const despesasPorCategoria = {};

        transactions.forEach(t => {
            const categoria = t.planoDeConta || 'Sem Categoria';
            if (t.entrada > 0) {
                if (!receitasPorCategoria[categoria]) receitasPorCategoria[categoria] = 0;
                receitasPorCategoria[categoria] += t.entrada;
            }
            if (t.saida > 0) {
                if (!despesasPorCategoria[categoria]) despesasPorCategoria[categoria] = 0;
                despesasPorCategoria[categoria] += t.saida;
            }
        });

        const sortAndSlice = (data) => Object.entries(data)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5);

        const topReceitasRaw = sortAndSlice(receitasPorCategoria);
        const topDespesasRaw = sortAndSlice(despesasPorCategoria);

        const topReceitas = {
            labels: topReceitasRaw.map(([label]) => label),
            data: topReceitasRaw.map(([, value]) => value / 100)
        };

        const topDespesas = {
            labels: topDespesasRaw.map(([label]) => label),
            data: topDespesasRaw.map(([, value]) => value / 100)
        };

        return { topReceitas, topDespesas };
    }

    async function processAndRenderComparativoPeriodos() {
        const startDateStr = periodoDeInput.value;
        const endDateStr = periodoAteInput.value;
        if (!startDateStr || !endDateStr) return;

        const startDate = new Date(startDateStr + 'T00:00:00');
        const endDate = new Date(endDateStr + 'T00:00:00');
        const diffTime = Math.abs(endDate - startDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // +1 to be inclusive

        const prevEndDate = new Date(startDate);
        prevEndDate.setDate(prevEndDate.getDate() - 1);
        const prevStartDate = new Date(prevEndDate);
        prevStartDate.setDate(prevStartDate.getDate() - diffDays + 1);

        const prevStartDateStr = prevStartDate.toISOString().split('T')[0];
        const prevEndDateStr = prevEndDate.toISOString().split('T')[0];

        try {
            const [pagamentosAnteriores, recebimentosAnteriores] = await Promise.all([
                fetchTransactionsEfficiently('despesas', 'pagamentos', prevStartDateStr, prevEndDateStr),
                fetchTransactionsEfficiently('receitas', 'recebimentos', prevStartDateStr, prevEndDateStr)
            ]);

            const transacoesAnteriores = await enrichAndUnifyTransactions(pagamentosAnteriores, recebimentosAnteriores, []);
            const kpisAnteriores = calculateKPIs(0, transacoesAnteriores, 'todas');

            const [pagamentosAtuais, recebimentosAtuais] = await Promise.all([
                fetchTransactionsEfficiently('despesas', 'pagamentos', startDateStr, endDateStr),
                fetchTransactionsEfficiently('receitas', 'recebimentos', startDateStr, endDateStr)
            ]);
            const transacoesAtuais = await enrichAndUnifyTransactions(pagamentosAtuais, recebimentosAtuais, []);
            const kpisAtuais = calculateKPIs(0, transacoesAtuais, 'todas');

            const data = {
                labels: ['Entradas', 'Saídas'],
                periodoAtual: [kpisAtuais.totalEntradas / 100, kpisAtuais.totalSaidas / 100],
                periodoAnterior: [kpisAnteriores.totalEntradas / 100, kpisAnteriores.totalSaidas / 100]
            };

            renderComparativoPeriodosChart(data);

        } catch (error) {
            console.error("Erro ao processar dados para gráfico comparativo:", error);
        }
    }

    // --- Chart Rendering Functions ---
    function renderWhatIfEvolucaoSaldoChart({ labels, realizadoData, projetadoData, simuladoData, comparadoData, lastRealizedDayIndex }) {
        const ctx = document.getElementById('chart-what-if-evolucao-saldo')?.getContext('2d');
        if (!ctx) return;

        if (chartInstances.whatIfEvolucaoSaldo) {
            chartInstances.whatIfEvolucaoSaldo.destroy();
        }

        const showRealizado = visaoRealizadoCheckbox.checked;
        const showProjetado = visaoProjetadoCheckbox.checked;

        const datasets = [];

        if (showRealizado) {
            datasets.push({
                label: 'Saldo Realizado',
                data: realizadoData,
                borderColor: 'rgba(54, 162, 235, 1)',
                backgroundColor: 'rgba(54, 162, 235, 0.2)',
                fill: false,
                tension: 0.1
            });
        }

        if (showProjetado) {
            datasets.push({
                label: 'Projeção Base',
                data: projetadoData,
                borderColor: 'rgba(255, 159, 64, 1)',
                borderDash: [5, 5],
                backgroundColor: 'rgba(255, 159, 64, 0.2)',
                fill: false,
                tension: 0.1
            });
        }

        if (whatIfScenario.length > 0 && (showRealizado || showProjetado)) {
            datasets.push({
                label: 'Projeção Simulada',
                data: simuladoData,
                borderColor: 'rgba(75, 192, 192, 1)',
                 borderDash: [5, 5],
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                fill: false,
                tension: 0.1
            });
        }

        if (comparisonScenario && (showRealizado || showProjetado)) {
            datasets.push({
                label: 'Projeção Comparada',
                data: comparadoData,
                borderColor: 'rgba(153, 102, 255, 1)',
                borderDash: [5, 5],
                backgroundColor: 'rgba(153, 102, 255, 0.2)',
                fill: false,
                tension: 0.1
            });
        }

        if (datasets.length === 0) {
             // If no datasets, clear the canvas
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            return;
        }

        chartInstances.whatIfEvolucaoSaldo = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        ticks: {
                            callback: value => formatCurrency(value * 100) // Convert back to cents for formatting
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: context => `${context.dataset.label}: ${formatCurrency(context.raw * 100)}`
                        }
                    }
                }
            }
        });
    }

    function renderReceitaVsDespesaChart({ labels, receitas, despesas }) {
        const ctx = document.getElementById('chart-receita-vs-despesa')?.getContext('2d');
        if (!ctx) return;

        chartInstances.receitaVsDespesa = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Receitas',
                        data: receitas,
                        backgroundColor: 'rgba(75, 192, 192, 0.6)',
                        borderColor: 'rgba(75, 192, 192, 1)',
                        borderWidth: 1
                    },
                    {
                        label: 'Despesas',
                        data: despesas,
                        backgroundColor: 'rgba(255, 99, 132, 0.6)',
                        borderColor: 'rgba(255, 99, 132, 1)',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: value => 'R$ ' + value.toLocaleString('pt-BR')
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: context => `${context.dataset.label}: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(context.raw)}`
                        }
                    }
                }
            }
        });
    }

    function renderAcumuladoMensalChart({ labels, receitasAcumuladas, despesasAcumuladas }) {
        const ctx = document.getElementById('chart-acumulado-mensal')?.getContext('2d');
        if (!ctx) return;

        chartInstances.acumuladoMensal = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Receitas Acumuladas',
                        data: receitasAcumuladas,
                        borderColor: 'rgba(75, 192, 192, 1)',
                        backgroundColor: 'rgba(75, 192, 192, 0.2)',
                        fill: true,
                        tension: 0.1
                    },
                    {
                        label: 'Despesas Acumuladas',
                        data: despesasAcumuladas,
                        borderColor: 'rgba(255, 99, 132, 1)',
                        backgroundColor: 'rgba(255, 99, 132, 0.2)',
                        fill: true,
                        tension: 0.1
                    }
                ]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: value => 'R$ ' + value.toLocaleString('pt-BR')
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: context => `${context.dataset.label}: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(context.raw)}`
                        }
                    }
                }
            }
        });
    }

    function renderEvolucaoSaldoChart({ labels, dataPoints, lastRealizedDayIndex }) {
        const ctx = document.getElementById('chart-evolucao-saldo')?.getContext('2d');
        if (!ctx) return;

        let realizadoData = [];
        let projetadoData = [];

        if (lastRealizedDayIndex < 0) {
            // All data is projected
            realizadoData = [];
            projetadoData = dataPoints;
        } else {
            realizadoData = dataPoints.slice(0, lastRealizedDayIndex + 2); // +2 to connect the lines
            projetadoData = new Array(lastRealizedDayIndex).fill(null).concat(dataPoints.slice(lastRealizedDayIndex));
        }

        chartInstances.evolucaoSaldo = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Saldo Realizado',
                        data: realizadoData,
                        borderColor: 'rgba(54, 162, 235, 1)',
                        backgroundColor: 'rgba(54, 162, 235, 0.2)',
                        fill: false,
                        tension: 0.1
                    },
                    {
                        label: 'Saldo Projetado',
                        data: projetadoData,
                        borderColor: 'rgba(54, 162, 235, 1)',
                        borderDash: [5, 5], // This makes the line dotted/dashed
                        backgroundColor: 'rgba(54, 162, 235, 0.2)',
                        fill: false,
                        tension: 0.1
                    }
                ]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        ticks: {
                            callback: value => 'R$ ' + value.toLocaleString('pt-BR')
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: context => `Saldo: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(context.raw)}`
                        }
                    }
                }
            }
        });
    }

    function renderDespesasCategoriaChart({ labels, datasets }) {
        const ctx = document.getElementById('chart-despesas-categoria')?.getContext('2d');
        if (!ctx) return;

        const colors = [
            'rgba(255, 99, 132, 0.7)', 'rgba(54, 162, 235, 0.7)', 'rgba(255, 206, 86, 0.7)',
            'rgba(75, 192, 192, 0.7)', 'rgba(153, 102, 255, 0.7)', 'rgba(255, 159, 64, 0.7)',
            'rgba(199, 199, 199, 0.7)', 'rgba(83, 102, 255, 0.7)', 'rgba(255, 99, 255, 0.7)'
        ];

        datasets.forEach((dataset, index) => {
            dataset.backgroundColor = colors[index % colors.length];
        });

        chartInstances.despesasCategoria = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                scales: {
                    x: { stacked: true },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: {
                            callback: value => 'R$ ' + value.toLocaleString('pt-BR')
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: context => `${context.dataset.label}: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(context.raw)}`
                        }
                    }
                }
            }
        });
    }

    function renderTop5ReceitasChart({ labels, data }) {
        const ctx = document.getElementById('chart-top-5-receitas')?.getContext('2d');
        if (!ctx) return;

        chartInstances.top5Receitas = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Top 5 Receitas',
                    data: data,
                    backgroundColor: 'rgba(75, 192, 192, 0.6)',
                    borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                indexAxis: 'y', // This makes the bar chart horizontal
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: context => `Total: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(context.raw)}`
                        }
                    }
                }
            }
        });
    }

    function renderTop5DespesasChart({ labels, data }) {
        const ctx = document.getElementById('chart-top-5-despesas')?.getContext('2d');
        if (!ctx) return;

        chartInstances.top5Despesas = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Top 5 Despesas',
                    data: data,
                    backgroundColor: 'rgba(255, 99, 132, 0.6)',
                    borderColor: 'rgba(255, 99, 132, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: context => `Total: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(context.raw)}`
                        }
                    }
                }
            }
        });
    }

    function renderComparativoPeriodosChart({ labels, periodoAtual, periodoAnterior }) {
        const ctx = document.getElementById('chart-comparativo-periodos')?.getContext('2d');
        if (!ctx) return;

        chartInstances.comparativoPeriodos = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Período Anterior',
                        data: periodoAnterior,
                        backgroundColor: 'rgba(156, 163, 175, 0.6)',
                        borderColor: 'rgba(156, 163, 175, 1)',
                        borderWidth: 1
                    },
                    {
                        label: 'Período Atual',
                        data: periodoAtual,
                        backgroundColor: 'rgba(59, 130, 246, 0.6)',
                        borderColor: 'rgba(59, 130, 246, 1)',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: value => 'R$ ' + value.toLocaleString('pt-BR')
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: context => `${context.dataset.label}: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(context.raw)}`
                        }
                    }
                }
            }
        });
    }


    async function populateContasBancarias() {
        const q = query(collection(db, `users/${userId}/contasBancarias`));
        const snapshot = await getDocs(q);
        allContasBancarias = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        contaBancariaSelect.innerHTML = '<option value="todas">Todas as Contas</option>';
        allContasBancarias.forEach(conta => {
            const option = document.createElement('option');
            option.value = conta.id;
            option.textContent = conta.nome;
            contaBancariaSelect.appendChild(option);
        });

        // Also populate transfer modal dropdowns
        const origemSelect = document.getElementById('transferencia-conta-origem');
        const destinoSelect = document.getElementById('transferencia-conta-destino');
        origemSelect.innerHTML = '<option value="">Selecione a conta de origem</option>';
        destinoSelect.innerHTML = '<option value="">Selecione a conta de destino</option>';
         allContasBancarias.forEach(conta => {
            const opt1 = document.createElement('option');
            opt1.value = conta.id;
            opt1.textContent = conta.nome;
            origemSelect.appendChild(opt1);
            const opt2 = document.createElement('option');
            opt2.value = conta.id;
            opt2.textContent = conta.nome;
            destinoSelect.appendChild(opt2);
        });
    }

    // --- Event Listeners ---
    [periodoDeInput, periodoAteInput, contaBancariaSelect].forEach(el => {
        el.addEventListener('change', calculateAndRenderCashFlow);
    });

    conciliacaoFilterGroup.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            conciliacaoFilterGroup.querySelector('.active').classList.remove('active');
            e.target.classList.add('active');
            activeConciliacaoFilter = e.target.dataset.status;
            calculateAndRenderCashFlow();
        }
    });

    [visaoRealizadoCheckbox, visaoProjetadoCheckbox, whatIfIncludeProjectionsCheckbox].forEach(el => {
        if(el) el.addEventListener('change', calculateAndRenderCashFlow);
    });

    extratoTableBody.addEventListener('change', async (e) => {
        if (e.target.classList.contains('fluxo-checkbox')) {
            const checkbox = e.target;
            const transacaoId = checkbox.dataset.id;
            const parentId = checkbox.dataset.parentId;
            const type = checkbox.dataset.type;
            const isConciliado = checkbox.checked;

            if (!transacaoId || !parentId || !type) {
                console.error("Dados da transação ausentes no checkbox.");
                return;
            }

            const collectionName = type === 'pagamento' ? 'pagamentos' : 'recebimentos';
            const parentCollectionName = type === 'pagamento' ? 'despesas' : 'receitas';

            const docRef = doc(db, `users/${userId}/${parentCollectionName}/${parentId}/${collectionName}/${transacaoId}`);

            try {
                await updateDoc(docRef, { conciliado: isConciliado });
                const row = checkbox.closest('tr');
                row.classList.toggle('bg-green-50', isConciliado);
            } catch (error) {
                console.error("Erro ao atualizar status de conciliação:", error);
                alert("Não foi possível atualizar o status da transação.");
                // Revert checkbox state on error
                checkbox.checked = !isConciliado;
            }
        }
    });

    lancarTransferenciaBtn.addEventListener('click', () => {
        transferenciaModal.classList.remove('hidden');
    });
    closeTransferenciaModalBtn.addEventListener('click', () => transferenciaModal.classList.add('hidden'));
    cancelTransferenciaModalBtn.addEventListener('click', () => transferenciaModal.classList.add('hidden'));

    transferenciaForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const feedbackId = 'transferencia-form-feedback';
        const contaOrigemId = document.getElementById('transferencia-conta-origem').value;
        const contaDestinoId = document.getElementById('transferencia-conta-destino').value;
        const valor = toCents(document.getElementById('transferencia-valor').value);
        const data = document.getElementById('transferencia-data').value;

        if(contaOrigemId === contaDestinoId) {
            showFeedback(feedbackId, "A conta de origem e destino não podem ser a mesma.", true);
            return;
        }
        if(!valor || !data || !contaOrigemId || !contaDestinoId) {
             showFeedback(feedbackId, "Todos os campos são obrigatórios.", true);
            return;
        }

        try {
            const contaOrigemNome = allContasBancarias.find(c => c.id === contaOrigemId).nome;
            const contaDestinoNome = allContasBancarias.find(c => c.id === contaDestinoId).nome;

            await addDoc(collection(db, `users/${userId}/transferencias`), {
                dataTransacao: data,
                valor: valor,
                contaOrigemId,
                contaDestinoId,
                contaOrigemNome,
                contaDestinoNome,
                observacao: document.getElementById('transferencia-obs').value,
                adminId: userId,
                createdAt: serverTimestamp()
            });
            showFeedback(feedbackId, "Transferência salva com sucesso!", false);
            transferenciaForm.reset();
            transferenciaModal.classList.add('hidden');
            calculateAndRenderCashFlow();
        } catch(error) {
            console.error("Erro ao salvar transferência:", error);
            showFeedback(feedbackId, "Erro ao salvar. Tente novamente.", true);
        }
    });

    // --- What-If Logic ---
    function handleWhatIfFormSubmit(event) {
        event.preventDefault();
        const form = event.target;
        const isReceita = form.id.includes('receita');
        const type = isReceita ? 'receita' : 'despesa';

        const descricao = form.querySelector(`#what-if-${type}-descricao`).value;
        const valorTotal = toCents(form.querySelector(`#what-if-${type}-valor`).value);
        const dataInicio = form.querySelector(`#what-if-${type}-data`).value;
        const formaPagamento = form.querySelector(`#what-if-${type}-forma-pagamento`).value;

        if (!descricao || !valorTotal || !dataInicio) {
            alert("Por favor, preencha Descrição, Valor e Data de Início.");
            return;
        }

        const baseId = `what-if-${Date.now()}`;
        let transactionsToAdd = [];

        if (formaPagamento === 'single') {
            transactionsToAdd.push({
                id: baseId,
                type: type,
                descricao: descricao,
                data: dataInicio,
                valor: valorTotal,
                groupId: baseId
            });
        } else if (formaPagamento === 'installment') {
            const numParcelas = parseInt(form.querySelector(`#what-if-${type}-installments`).value, 10);
            if (!numParcelas || numParcelas <= 0) { alert("Número de parcelas inválido."); return; }

            const valorParcela = Math.round(valorTotal / numParcelas);
            for (let i = 0; i < numParcelas; i++) {
                const dataParcela = new Date(dataInicio + 'T00:00:00');
                dataParcela.setMonth(dataParcela.getMonth() + i);
                transactionsToAdd.push({
                    id: `${baseId}-${i}`,
                    type: type,
                    descricao: `${descricao} (Parcela ${i + 1}/${numParcelas})`,
                    data: dataParcela.toISOString().split('T')[0],
                    valor: valorParcela,
                    groupId: baseId
                });
            }
        } else if (formaPagamento === 'recurring') {
            const numRecorrencias = parseInt(form.querySelector(`#what-if-${type}-recurrences`).value, 10);
            if (!numRecorrencias || numRecorrencias <= 0) { alert("Número de ocorrências inválido."); return; }

            const frequencia = form.querySelector(`#what-if-${type}-recurring-frequency`).value;
            const multiplier = getRecurrenceMultiplier(frequencia);

            for (let i = 0; i < numRecorrencias; i++) {
                const dataRecorrencia = new Date(dataInicio + 'T00:00:00');
                dataRecorrencia.setMonth(dataRecorrencia.getMonth() + (i * multiplier));
                transactionsToAdd.push({
                    id: `${baseId}-${i}`,
                    type: type,
                    descricao: `${descricao} (Recorrência ${i + 1}/${numRecorrencias})`,
                    data: dataRecorrencia.toISOString().split('T')[0],
                    valor: valorTotal, // For recurring, the value is per occurrence
                    groupId: baseId
                });
            }
        }

        whatIfScenario.push(...transactionsToAdd);
        form.reset();
        // Manually trigger change to hide conditional fields again
        form.querySelector('select[id*="forma-pagamento"]').dispatchEvent(new Event('change'));
        renderWhatIfItems();
        calculateAndRenderCashFlow();
    }

    function renderWhatIfItems() {
        if (whatIfScenario.length === 0) {
            whatIfItemsContainer.innerHTML = `<p class="text-center text-gray-500 text-sm">Nenhum item adicionado à simulação.</p>`;
            return;
        }

        whatIfItemsContainer.innerHTML = '';
        whatIfScenario.forEach(item => {
            const isReceita = item.type === 'receita';
            const itemEl = document.createElement('div');
            itemEl.className = `flex justify-between items-center p-2 rounded-md ${isReceita ? 'bg-green-50' : 'bg-red-50'}`;
            itemEl.innerHTML = `
                <div class="text-sm">
                    <p class="font-medium ${isReceita ? 'text-green-800' : 'text-red-800'}">${item.descricao}</p>
                    <p class="text-xs text-gray-500">${new Date(item.data + 'T00:00:00').toLocaleDateString('pt-BR')} - ${formatCurrency(item.valor)}</p>
                </div>
                <button class="what-if-remove-item-btn text-gray-400 hover:text-red-600" data-id="${item.id}">
                    <span class="material-symbols-outlined text-base">delete</span>
                </button>
            `;
            whatIfItemsContainer.appendChild(itemEl);
        });
    }

    whatIfItemsContainer.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.what-if-remove-item-btn');
        if (removeBtn) {
            const itemId = removeBtn.dataset.id;
            whatIfScenario = whatIfScenario.filter(item => item.id !== itemId);
            renderWhatIfItems();
            calculateAndRenderCashFlow();
        }
    });

    whatIfClearScenarioBtn.addEventListener('click', () => {
        whatIfScenario = [];
        renderWhatIfItems();
        calculateAndRenderCashFlow();
    });

    whatIfSaveScenarioBtn.addEventListener('click', () => {
        const scenarioName = prompt("Digite um nome para este cenário:", "Cenário Salvo");
        if (scenarioName && whatIfScenario.length > 0) {
            savedScenarios.push({
                id: `saved-${Date.now()}`,
                name: scenarioName,
                transactions: JSON.parse(JSON.stringify(whatIfScenario)) // Deep copy
            });
            renderSavedScenarios();
        }
    });

    function renderSavedScenarios() {
        cenariosSalvosList.innerHTML = '';
        if (savedScenarios.length === 0) {
            cenariosSalvosList.innerHTML = '<p class="text-center text-gray-500">Nenhum cenário salvo ainda.</p>';
            return;
        }

        savedScenarios.forEach(scenario => {
            const scenarioEl = document.createElement('div');
            scenarioEl.className = 'flex justify-between items-center p-2 rounded-md bg-gray-50';
            scenarioEl.innerHTML = `
                <span class="font-medium text-gray-700">${scenario.name}</span>
                <div class="flex items-center space-x-2">
                    <input type="checkbox" class="form-checkbox h-4 w-4 text-purple-600 what-if-compare-checkbox" data-scenario-id="${scenario.id}">
                    <label class="text-sm text-gray-600">Comparar</label>
                    <button class="text-sm text-blue-600 hover:underline what-if-load-btn" data-scenario-id="${scenario.id}">Carregar</button>
                    <button class="text-sm text-red-600 hover:underline what-if-delete-btn" data-scenario-id="${scenario.id}">Excluir</button>
                </div>
            `;
            cenariosSalvosList.appendChild(scenarioEl);
        });
    }

    cenariosSalvosList.addEventListener('click', (e) => {
        const target = e.target;
        const scenarioId = target.dataset.scenarioId;
        if (!scenarioId) return;

        if (target.classList.contains('what-if-load-btn')) {
            const scenarioToLoad = savedScenarios.find(s => s.id === scenarioId);
            if (scenarioToLoad) {
                whatIfScenario = JSON.parse(JSON.stringify(scenarioToLoad.transactions));
                renderWhatIfItems();
                calculateAndRenderCashFlow();
            }
        } else if (target.classList.contains('what-if-delete-btn')) {
            savedScenarios = savedScenarios.filter(s => s.id !== scenarioId);
            renderSavedScenarios();
        } else if (target.classList.contains('what-if-compare-checkbox')) {
            const checkbox = target;
            document.querySelectorAll('.what-if-compare-checkbox').forEach(cb => {
                if (cb !== checkbox) cb.checked = false;
            });

            if (checkbox.checked) {
                const scenarioToCompare = savedScenarios.find(s => s.id === scenarioId);
                comparisonScenario = scenarioToCompare ? scenarioToCompare.transactions : null;
            } else {
                comparisonScenario = null;
            }
            calculateAndRenderCashFlow();
        }
    });

    function getRecurrenceMultiplier(freq) {
        switch (freq) {
            case 'bimestral': return 2;
            case 'trimestral': return 3;
            case 'semestral': return 6;
            case 'anual': return 12;
            default: return 1; // mensal
        }
    }

    function setupWhatIfFormListeners(formId) {
        const form = document.getElementById(formId);
        if (!form) return;

        const formaPagamentoSelect = form.querySelector('select[id*="forma-pagamento"]');
        const installmentFields = form.querySelector('div[id*="installment-fields"]');
        const recurringFields = form.querySelector('div[id*="recurring-fields"]');

        formaPagamentoSelect.addEventListener('change', () => {
            const selection = formaPagamentoSelect.value;
            if(installmentFields) installmentFields.classList.toggle('hidden', selection !== 'installment');
            if(recurringFields) recurringFields.classList.toggle('hidden', selection !== 'recurring');
        });
    }

    setupWhatIfFormListeners('what-if-receita-form');
    setupWhatIfFormListeners('what-if-despesa-form');

    // --- Initial Load ---
    function setDefaultDates() {
        const today = new Date();
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        periodoDeInput.value = firstDayOfMonth.toISOString().split('T')[0];
        periodoAteInput.value = lastDayOfMonth.toISOString().split('T')[0];
    }

    // --- Initial Load & Event Listeners ---
    function initializePage() {
        setDefaultDates();
        populateContasBancarias().then(() => {
            calculateAndRenderCashFlow();
        });
    }

    // Initialize the page immediately
    initializePage();

    whatIfReceitaForm.addEventListener('submit', handleWhatIfFormSubmit);
    whatIfDespesaForm.addEventListener('submit', handleWhatIfFormSubmit);

    // Add an event listener to refresh data when the view is shown
    document.addEventListener('view-shown', (e) => {
        if (e.detail.viewId === 'fluxo-de-caixa-page') {
            console.log("Fluxo de Caixa view shown, refreshing data...");
            calculateAndRenderCashFlow();
        }
    });

    // Setup tab functionality
    const tabLinks = fluxoDeCaixaPage.querySelectorAll('.fluxo-tab-link');
    const tabContents = fluxoDeCaixaPage.querySelectorAll('.fluxo-tab-content');

    tabLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();

            // Remove active class from all tabs and hide all content
            tabLinks.forEach(item => {
                item.classList.remove('active');
            });
            tabContents.forEach(content => content.classList.add('hidden'));

            // Add active class to the clicked tab and show its content
            link.classList.add('active');
            const activeContentId = `fluxo-${link.dataset.fluxoTab}-tab`;
            const activeContent = document.getElementById(activeContentId);
            if (activeContent) {
                activeContent.classList.remove('hidden');
            }
        });
    });
}
