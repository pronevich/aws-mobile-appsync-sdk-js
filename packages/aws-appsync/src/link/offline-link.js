/*!
 * Copyright 2017-2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Amazon Software License (the "License"). You may not use this file except in compliance with the License. A copy of 
 * the License is located at
 *     http://aws.amazon.com/asl/
 * or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY 
 * KIND, express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
import { readQueryFromStore, defaultNormalizedCacheFactory } from "apollo-cache-inmemory";
import { ApolloLink, Observable } from "apollo-link";
import { getOperationDefinition, getOperationName } from "apollo-utilities";
import { Store } from 'redux';

import { NORMALIZED_CACHE_KEY } from "../cache";

export class OfflineLink extends ApolloLink {

    /**
     * @type {Store}
     * @private
     */
    store;

    /**
     * 
     * @param {Store} store 
     */
    constructor(store) {
        this.store = store;
    }

    request(operation, forward) {
        return new Observable(observer => {
            const { offline: { online } } = this.store.getState();
            const { operation: operationType } = getOperationDefinition(operation.query);
            const isMutation = operationType === 'mutation';
            const isQuery = operationType === 'query';

            if (!online && isQuery) {
                const data = processOfflineQuery(operation, this.store);

                observer.next({ data });
                observer.complete();

                return () => null;
            }

            if (isMutation) {
                const data = processMutation(operation, this.store);

                // If we got data, it is the optimisticResponse, we send it to the observer
                // Otherwise, we allow the mutation to continue in the link chain
                if (data) {
                    observer.next({ data });
                    observer.complete();

                    return () => null;
                } else {
                    // console.log('Processing mutation');
                }
            }

            const handle = forward(operation).subscribe({
                next: observer.next.bind(observer),
                error: observer.error.bind(observer),
                complete: observer.complete.bind(observer),
            });

            return () => {
                if (handle) handle.unsubscribe();
            };
        });
    }
}

const processOfflineQuery = (operation, theStore) => {
    const { [NORMALIZED_CACHE_KEY]: normalizedCache = {} } = theStore.getState();
    const { query, variables } = operation;

    const store = defaultNormalizedCacheFactory(normalizedCache);

    const data = readQueryFromStore({
        store,
        query,
        variables,
    });

    return data;
}

const processMutation = (operation, theStore) => {
    const { AASContext } = operation.getContext();
    const { mutation, variables, optimisticResponse, refetchQueries, doIt } = AASContext;

    if (doIt) {
        return;
    }

    const data = optimisticResponse ?
        typeof optimisticResponse === 'function' ?
            { ...optimisticResponse(variables) } :
            optimisticResponse
        : null;

    // console.log('Queuing mutation');
    theStore.dispatch({
        type: 'SOME_ACTION',
        payload: {},
        meta: {
            offline: {
                effect: {
                    mutation,
                    variables,
                    refetchQueries,
                    doIt: true,
                },
                commit: { type: 'SOME_ACTION_COMMIT', meta: null },
                rollback: { type: 'SOME_ACTION_ROLLBACK', meta: null },
            }
        }
    });

    return data;
}

export const reducer = () => ({
    eclipse: (state = {}, action) => {
        const { type, payload } = action;
        switch (type) {
            case 'SOME_ACTION':
                return {
                    ...state,
                };
            case 'SOME_ACTION_COMMIT':
                return {
                    ...state,
                };
            case 'SOME_ACTION_ROLLBACK':
                return {
                    ...state,
                };
            default:
                return state;
        }
    }
});

/**
 * 
 * @param {*} client 
 * @param {*} effect 
 * @param {*} action 
 */
export const offlineEffect = (client, effect, action) => {
    const { type } = action;
    const { mutation, variables, refetchQueries, doIt } = effect;

    const context = {
        AASContext: {
            doIt,
        },
    };

    const options = {
        mutation,
        variables,
        refetchQueries,
        context,
    };

    return client.mutate(options);
}

export const discard = (fn = () => null) => (error, action, retries) => {
    const { graphQLErrors = [] } = error;
    const conditionalCheck = graphQLErrors.find(err => err.errorType === 'DynamoDB:ConditionalCheckFailedException');

    if (conditionalCheck) {
        if (typeof fn === 'function') {
            const { data, path } = conditionalCheck;
            const { meta: { offline: { effect: { mutation, variables } } } } = action;
            const mutationName = getOperationName(mutation);
            const operationDefinition = getOperationDefinition(mutation)
            const { operation: operationType } = operationDefinition;

            try {
                const conflictResolutionResult = fn({
                    mutation,
                    mutationName,
                    operationType,
                    variables,
                    data,
                    retries,
                });

                if (conflictResolutionResult === 'DISCARD') {
                    return true;
                }

                if (!!conflictResolutionResult) {
                    action.meta.offline.effect.variables = conflictResolutionResult;

                    return false;
                }
            } catch (err) {
                // console.error('Error running conflict resolution. Discarding mutation.', err);

                return true;
            }
        }
    } else if (graphQLErrors.length) {
        // console.error('Discarding action.', action, graphQLErrors);

        return true;
    } else {
        const { networkError: { graphQLErrors } = { graphQLErrors: [] } } = error;
        const appSyncClientError = graphQLErrors.find(err => err.errorType && err.errorType.startsWith('AWSAppSyncClient:'));

        if (appSyncClientError) {
            // console.error('Discarding action.', action, appSyncClientError);

            return true;
        }
    }

    return error.permanent || retries > 10;
};
