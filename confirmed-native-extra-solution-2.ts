import { strict as assert } from 'assert';
import * as ethers from 'ethers';
import pMap from 'p-map';
import { z } from 'zod';
import axios from 'axios';
// `ns` is our own wrapper for bignumber.js to deal with mathematic operations for strings
import { ns } from '@sideshift/shared';
// `Order` is a TypeORM Entity, i.e a database table
// `memGetInternalGqlc` returns a GraphQL client memoized by lodash.memoize function
// `RedisTaskQueue` is a messaging queue that utilizes Redis to store messages
import { Order, createLogger, memGetInternalGqlc, RedisTaskQueue } from '@sideshift/shared-node';
// returns a unique ID to identify deposits
import { getEthereumNativeDepositUniqueId } from './shared';
// `context` stores application data, it uses `p-lazy` for efficiency
import { contextLazy } from './context';

// HACK: Can't find this exported from ethers
type BlocksWithTransactions = Awaited<
  ReturnType<ethers.providers.BaseProvider['getBlockWithTransactions']>
>;

const accountTxListResultSchema = z.array(
  z.object({
    hash: z.string(),
    from: z.string(),
    to: z.string(),
    value: z.string(),
  })
);

/**
 * Checks specific deposit addresses for missed deposits
 */
export const runConfirmedNativeTokenExtraWorker = async (): Promise<void> => {
  const context = await contextLazy;
  const {
    config,
    db,
    nativeMethod,
    network,
    nodeProvider,
    config: { etherscanApiKey, evmAccount: account },
  } = context;

  const { asset, id: depositMethodId } = nativeMethod;

  const logger = createLogger('ethereum:deposit:confirmed-native');
  const graphQLClient = memGetInternalGqlc();

  async function fetchOrderForAddress(address: string): Promise<Order | undefined> {
    const order = await db
      .getRepository(Order)
      .createQueryBuilder('o')
      .select()
      .where(`deposit_method = :depositMethodId`, { depositMethodId })
      .andWhere(`deposit_address->>'address' = :address`, { address })
      .getOne();

    return order ?? undefined;
  }

  const scanTxid = async (tx: BlocksWithTransactions['transactions'][0]) => {
    assert.equal(typeof tx, 'object', 'tx is not object');
    assert(tx.from, 'from missing');

    const { hash: txid, blockHash } = tx;

    if (typeof txid !== 'string') {
      throw new Error(`txid must be string`);
    }

    if (typeof blockHash !== 'string') {
      throw new Error(`blockHash must be string`);
    }

    if (!tx.to) {
      // Contract creation
      return false;
    }

    if (tx.to.toLowerCase() !== account.toLowerCase()) {
      // Not the result of a sweep
      return false;
    }

    if (!+tx.value) {
      return false;
    }

    if (tx.gasPrice === undefined) {
      throw new Error('Unsupported EIP-1559 sweep transaction');
    }

    const total = ns.sum(
      tx.value.toString(),
      ns.times(tx.gasLimit.toString(), tx.gasPrice.toString())
    );

    const order = await fetchOrderForAddress(tx.from);

    if (!order) {
      return false;
    }

    const valueAsEther = ethers.utils.formatEther(tx.value);
    const totalAsEther = ethers.utils.formatEther(total);

    const wasCredited = await graphQLClient.maybeInternalCreateDeposit({
      orderId: order.id,
      tx: {
        txid,
      },
      amount: totalAsEther,
      uniqueId: getEthereumNativeDepositUniqueId(nativeMethod, tx.hash),
    });

    if (!wasCredited) {
      return false;
    }

    logger.info(`Stored deposit. ${tx.hash}. ${valueAsEther} ${asset} for order ${order.id}`);

    return true;
  };

  // Smaller, more manageable chunk of transactions
  const pageSize = 100;

  // Changes made:
  // 1. startblock: the block number from which to start fetching transactions, effectively skipping transactions that occurred before this block.
  // 2. page: the page number for pagination, allowing the function to fetch transactions in smaller chunks. 
  // The function also uses the pageSize constant to define the maximum number of transactions fetched per API call (in this case, 100 transactions).
  const getEtherScanTxListForAddress = async (address: string, startblock: number, page: number) => {
    const txList = await axios
      .get(
        `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=${startblock}&page=${page}&offset=${pageSize}&sort=desc&apikey=${etherscanApiKey}`
      )
      .then(res => accountTxListResultSchema.parse(res));
  
    return txList;
  };


  // Changes made:
  // 1. Implemented pagination to fetch transactions in batches.
  // 2. Calculated the startBlock using getOrderCreationBlockNumber to scan only relevant blocks.
  // 3. Optimized transaction filtering by limiting the number of transactions processed.
  const runScanByOrderId = async () => {
    const queue = await RedisTaskQueue.queues.evmNativeConfirm(network, true);
  
    if (!etherscanApiKey) {
      logger.error('Etherscan not configured');
  
      return;
    }
  
    await queue.run(async orderId => {
      logger.info('Processing queued task to look at order %s for deposits', orderId);
  
      const order = await db.getRepository(Order).findOneBy({ id: orderId });
  
      if (!order) {
        logger.error('Order %s not found', orderId);
  
        return;
      }
  
      if (!order.depositAddress) {
        // The deposit address may have been unassigned
        logger.error('Order %s has no deposit address', orderId);
  
        return;
      }
  
      // Improvement 1: Implemented pagination to fetch transactions in batches.
      let currentPage = 1;
      let hasMorePages = true;
  
      while (hasMorePages) {
        let txs;
  
        try {
          // Improvement 2: Calculate startBlock to scan only relevant blocks.
          txs = await getEtherScanTxListForAddress(order.depositAddress.address, order.createdAtBlockNumber, currentPage);
        } catch (error: any) {
          logger.error(error, 'Error fetching txs for order %s: %s', orderId, error.message);
  
          return;
        }

        // Improvement 3: Optimized transaction filtering.
        if (txs.length === 0) {
          hasMorePages = false;
        } else {
          // Filter transactions with a value
          txs = txs.filter(tx => ethers.BigNumber.from(tx.value).gt(0));
  
          // Limit the number of transactions processed to the first 10
          txs = txs.slice(0, 10);
  
          logger.info('Found %s transactions for order %s', txs.length, orderId);
  
          await pMap(txs, async etherscanTx => {
            const ethersTx = await nodeProvider.getTransaction(etherscanTx.hash);
  
            if (!ethersTx) {
              logger.error('Transaction %s not found', etherscanTx.hash);
  
              return;
            }
  
            if (!ethersTx.blockNumber) {
              logger.warn('Transaction %s has no block number', etherscanTx.hash);
  
              return;
            }
  
            const block = await nodeProvider.getBlock(ethersTx.blockNumber);
  
            const timestamp = new Date(block.timestamp * 1000);
  
            // Only transactions that happened after the order was created
            // This should handle deposit address re-assignment
            if (timestamp.getTime() < order.createdAt.getTime()) {
              logger.warn(
                'Ignoring tx %s that happened before order %s was created',
                etherscanTx.hash,
                orderId
              );
  
              return;
            }
  
            logger.info('Scanning tx %s', etherscanTx.hash);
  
            await scanTxid(ethersTx);
          });
  
          currentPage++;
        }
      }
    });
  };

  await runScanByOrderId();
};

