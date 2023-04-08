Solution 1: Calculate the start block based on order createdAt timestamp. (confirmed-native-extra.ts).

In this solution we edit getEtherScanTxListForAddress to have starting block and pagination.
These 2 new parameters brings speed and efficient for finding the right txs instead of fetching them all.
To continue with this solution, we have to make a function getOrderCreationBlockNumber which calculates the starting block.

Assumptions: I made an assumption for getOrderCreationBlockNumber that the nodeProvider object has a getBlock function. Because This is a common feature in most Ethereum provider libraries.

In the runScanByOrderId function, several improvements have been made. These improvements include:

    1.  Implementing pagination: By fetching transactions in smaller sets (pages) and iterating through them, the code handles transactions without loading all of them at once. This reduces memory usage and improves the overall performance of the function.

    2.  StartBlock optimization: Instead of fetching transactions from the beginning of the blockchain, the startBlock parameter is set to a block number close to the order's creation time. This will reduce the number of fetched transactions and makes the code more efficient.  

These improvements work together to create a more efficient solution, minimizing the time and resources required to scan and process transactions. This optimized implementation will enhance the performance of the runScanByOrderId function, making it more suitable for handling a large number of transactions in a scalable manner.



Solution 2: Assuming the Order model has the right property or editing the Order model myself. (confirmed-native-extra-solution-2.ts)

This solution is similar to one above. But instead of calculating starting block ourselves. We implement a new property for Order model
(Assuming it does not have this property)

    1.  We could edit Order Model to have createdAtBlockNumber property. For example like this:

    @Entity()
    export class Order {
    // other properties...

    @Column({ nullable: true, type: 'bigint' })
    createdAtBlockNumber: number;

    // other properties and methods...
    }


    2.  When creating a new order, fetch the current block number using nodeProvider.getBlockNumber() and store it in the createdAtBlockNumber property. This could be done so:

    const currentBlockNumber = await nodeProvider.getBlockNumber();
    const createdAtBlockNumber = currentBlockNumber;


    3.  When calling the getEtherScanTxListForAddress function, pass the order.createdAtBlockNumber as the startBlock parameter.

These improvements would work similarly like the solution 1. But it would be faster because we would not need to loop and search for correct startBlock.



Conclusions:

Currently, I see that it is not necessary to fetch all the tx from the blockchain and this process could be optimized by knowing the start block and using pagination.